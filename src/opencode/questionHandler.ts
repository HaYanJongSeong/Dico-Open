import { suppressLinkPreviews } from '../discord/messageOptions.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_LETTERED_OPTIONS = 26;
const logger = createLogger('QuestionHandler');

/** OpenCode question option. */
export interface QuestionOption {
  label: string;
  description: string;
  /** CLI v2 form value submitted for this option; defaults to `label`. */
  value?: string;
}

/** OpenCode question information. */
export interface QuestionInfo {
  header: string;
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** OpenCode question request payload. */
export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  /** CLI v2 form field keys aligned with `questions`; indexes are used when absent. */
  keys?: string[];
}

/** Answers keyed by CLI v2 form field key. */
export type QuestionAnswerMap = Record<string, string | string[]>;

/** OpenCode client subset required to answer questions. */
export interface QuestionClient {
  question: {
    /**
     * Reply to an OpenCode question request.
     * @param input - Request ID, session ID, and collected answers.
     * @returns OpenCode reply result.
     */
    reply(input: { requestID: string; sessionID: string; answer: QuestionAnswerMap }): Promise<unknown>;

    /**
     * Reject an OpenCode question request.
     * @param input - Request and session IDs to reject.
     * @returns OpenCode reject result.
     */
    reject(input: { requestID: string; sessionID: string }): Promise<unknown>;
  };
}

/** Discord thread subset required by question handling. */
export interface QuestionThread {
  /**
   * Send a message or embed payload to the thread.
   * @param payload - Message content or embed payload.
   * @returns Discord API send result.
   */
  send(payload: string | { embeds?: unknown[]; content?: string; flags?: number }): Promise<unknown>;
}

/** Options for constructing a question handler. */
export interface QuestionHandlerOptions {
  /**
   * Resolve a Discord thread by ID.
   * @param threadId - Discord thread ID.
   * @returns Thread when available, otherwise undefined.
   */
  getThread(threadId: string): QuestionThread | undefined;
  timeoutMs?: number;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

interface PendingQuestionState {
  client: QuestionClient;
  requestID: string;
  sessionID: string;
  keys?: string[];
  questions: QuestionInfo[];
  currentIndex: number;
  collectedAnswers: string[][];
  timer?: unknown;
}

interface QuestionEventLike {
  request?: unknown;
}

interface SdkErrorEnvelope {
  error: {
    message?: string;
  };
}

/** Handles OpenCode question events and Discord text answers. */
export class QuestionHandler {
  private readonly pending = new Map<string, PendingQuestionState>();
  private readonly timeoutMs: number;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  /**
   * Create a question handler.
   * @param options - Question handler dependencies and timing configuration.
   * @returns QuestionHandler instance.
   */
  public constructor(private readonly options: QuestionHandlerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setTimer = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer = options.clearTimeout ?? ((timer: unknown) => {
      globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>);
    });
  }

  /**
   * Handle a question request from OpenCode.
   * @param threadId - Discord thread ID receiving the question.
   * @param event - OpenCode question event or direct request payload.
   * @param client - OpenCode client for replies.
   * @returns Completion once the first question has been posted or rejected.
   */
  public async handleQuestionEvent(threadId: string, event: unknown, client: QuestionClient): Promise<void> {
    const request = this.extractRequest(event);
    const validationError = this.getValidationError(request);
    if (validationError) {
      this.assertNoSdkError(await client.question.reject(this.rejectInput(request)), ErrorCode.QUESTION_INVALID_ANSWER);
      throw validationError;
    }
    const thread = this.options.getThread(threadId);

    if (!thread) {
      this.assertNoSdkError(await client.question.reject(this.rejectInput(request)), ErrorCode.QUESTION_TIMEOUT);
      return;
    }

    this.clearPending(threadId);
    const state: PendingQuestionState = {
      client,
      requestID: request.id,
      sessionID: request.sessionID,
      keys: request.keys,
      questions: request.questions,
      currentIndex: 0,
      collectedAnswers: [],
    };
    this.pending.set(threadId, state);
    this.resetTimer(threadId, state);
    await this.showCurrentQuestion(thread, state);
  }

  /**
   * Check whether a Discord thread has a pending OpenCode question.
   * @param threadId - Discord thread ID to check.
   * @returns True when a question is waiting for an answer.
   */
  public hasPendingQuestion(threadId: string): boolean {
    return this.pending.has(threadId);
  }

  /**
   * Handle a Discord message as an answer to the pending question.
   * @param threadId - Discord thread ID receiving the answer.
   * @param content - Raw user message content.
   * @param correlationId - Optional correlation ID for invalid answer notices.
   * @returns Completion once the answer has been processed.
   */
  public async handleQuestionAnswer(threadId: string, content: string, correlationId?: string): Promise<void> {
    const state = this.pending.get(threadId);
    if (!state) {
      return;
    }

    const thread = this.options.getThread(threadId);
    if (!thread) {
      this.clearPending(threadId);
      this.assertNoSdkError(await state.client.question.reject(this.rejectInput(state)), ErrorCode.QUESTION_TIMEOUT);
      return;
    }

    const question = state.questions[state.currentIndex];
    if (!question) {
      return;
    }

    const answers = this.parseAnswer(question, content);
    if (!answers) {
      const suffix = correlationId ? ` *(참조: ${correlationId})*` : '';
      await thread.send(suppressLinkPreviews(`잘못된 답변입니다. 표시된 선택지 중 하나를 선택하세요.${suffix}`));
      await this.showCurrentQuestion(thread, state);
      return;
    }

    state.collectedAnswers.push(answers);
    state.currentIndex += 1;

    if (state.currentIndex < state.questions.length) {
      this.resetTimer(threadId, state);
      await this.showCurrentQuestion(thread, state);
      return;
    }

    this.assertNoSdkError(
      await state.client.question.reply({
        requestID: state.requestID,
        sessionID: state.sessionID,
        answer: this.buildAnswerMap(state),
      }),
      ErrorCode.QUESTION_INVALID_ANSWER,
    );
    this.clearPending(threadId);
  }

  private rejectInput(source: Pick<QuestionRequest, 'id' | 'sessionID'> | PendingQuestionState): { requestID: string; sessionID: string } {
    return { requestID: 'requestID' in source ? source.requestID : source.id, sessionID: source.sessionID };
  }

  private buildAnswerMap(state: PendingQuestionState): QuestionAnswerMap {
    return Object.fromEntries(state.questions.map((question, index) => {
      const key = state.keys?.[index] ?? String(index);
      const values = state.collectedAnswers[index] ?? [];
      return [key, question.multiple ? values : (values[0] ?? '')];
    }));
  }

  /**
   * Clear a pending question and its timeout for a Discord thread.
   * @param threadId - Discord thread ID to clear.
   * @returns Nothing.
   */
  public clearPending(threadId: string): void {
    const state = this.pending.get(threadId);
    if (state?.timer) {
      this.clearTimer(state.timer);
    }
    this.pending.delete(threadId);
  }

  private extractRequest(event: unknown): QuestionRequest {
    const candidate = this.isQuestionEventLike(event) && event.request ? event.request : event;
    if (!this.isQuestionRequest(candidate)) {
      throw new BotError(ErrorCode.QUESTION_INVALID_ANSWER, 'Invalid question request payload');
    }
    return candidate;
  }

  private isQuestionEventLike(value: unknown): value is QuestionEventLike {
    return typeof value === 'object' && value !== null && 'request' in value;
  }

  private isQuestionRequest(value: unknown): value is QuestionRequest {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const request = value as Partial<QuestionRequest>;
    return typeof request.id === 'string' && typeof request.sessionID === 'string' && Array.isArray(request.questions)
      && (request.keys === undefined || (Array.isArray(request.keys) && request.keys.every((key) => typeof key === 'string')));
  }

  private getValidationError(request: QuestionRequest): BotError | undefined {
    if (request.questions.some((question) => !this.isQuestionInfo(question))) {
      return new BotError(ErrorCode.QUESTION_INVALID_ANSWER, 'Invalid question entry', { requestID: request.id });
    }

    const invalidQuestion = request.questions.find((question) => question.options.length > MAX_LETTERED_OPTIONS);
    if (invalidQuestion) {
      return new BotError(ErrorCode.QUESTION_INVALID_ANSWER, 'Question has too many options for lettered answers', {
        requestID: request.id,
        header: invalidQuestion.header,
        optionCount: invalidQuestion.options.length,
      });
    }
    return undefined;
  }

  private isQuestionInfo(value: unknown): value is QuestionInfo {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const question = value as Partial<QuestionInfo>;
    return typeof question.header === 'string'
      && typeof question.question === 'string'
      && Array.isArray(question.options)
      && question.options.every((option) => this.isQuestionOption(option));
  }

  private isQuestionOption(value: unknown): value is QuestionOption {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const option = value as Partial<QuestionOption>;
    return typeof option.label === 'string' && typeof option.description === 'string'
      && (option.value === undefined || typeof option.value === 'string');
  }

  private resetTimer(threadId: string, state: PendingQuestionState): void {
    if (state.timer) {
      this.clearTimer(state.timer);
    }

    state.timer = this.setTimer(() => {
      this.handleTimeout(threadId, state).catch((error: unknown) => {
        logger.warn('Question timeout handling failed', { code: ErrorCode.QUESTION_TIMEOUT, threadId, requestID: state.requestID, error });
      });
    }, this.timeoutMs);
  }

  private async handleTimeout(threadId: string, state: PendingQuestionState): Promise<void> {
    if (this.pending.get(threadId) !== state) {
      return;
    }

    this.pending.delete(threadId);
    this.assertNoSdkError(await state.client.question.reject(this.rejectInput(state)), ErrorCode.QUESTION_TIMEOUT);
    const thread = this.options.getThread(threadId);
    if (thread) {
      await thread.send(suppressLinkPreviews('질문 응답 시간이 만료되었습니다. 에이전트가 답변 없이 계속합니다.'));
    }
  }

  private async showCurrentQuestion(thread: QuestionThread, state: PendingQuestionState): Promise<void> {
    const question = state.questions[state.currentIndex];
    if (!question) {
      return;
    }
    await thread.send(suppressLinkPreviews(this.formatQuestion(question)));
  }

  private formatQuestion(question: QuestionInfo): string {
    const optionLines = question.options.map((option, index) => {
      const letter = String.fromCharCode(97 + index);
      return `${letter}) ${option.label} - ${option.description}`;
    });
    const instructions = this.createInstructions(question);
    return [`**${question.header}**`, question.question, ...optionLines, instructions].filter(Boolean).join('\n');
  }

  private createInstructions(question: QuestionInfo): string {
    if (question.multiple) {
      return question.custom === false
        ? '알파벳을 하나 이상 쉼표로 구분해 답하세요.'
        : '알파벳을 하나 이상 쉼표로 구분하거나 직접 답변을 작성하세요.';
    }

    return question.custom === false ? '선택지의 알파벳 한 글자로 답하세요.' : '선택지의 알파벳 한 글자 또는 직접 작성한 답변을 보내세요.';
  }

  private parseAnswer(question: QuestionInfo, content: string): string[] | undefined {
    const trimmed = content.trim();
    if (!trimmed) {
      return undefined;
    }

    const letterParts = trimmed.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
    const allLetters = letterParts.length > 0 && letterParts.every((part) => /^[a-z]$/.test(part));
    if (allLetters) {
      if (!question.multiple && letterParts.length > 1) {
        return undefined;
      }
      const labels: string[] = [];
      for (const part of letterParts) {
        const option = question.options[part.charCodeAt(0) - 97];
        if (!option) {
          return undefined;
        }
        labels.push(option.value ?? option.label);
      }
      return labels;
    }

    if (question.custom !== false) {
      return [trimmed];
    }

    return undefined;
  }

  private assertNoSdkError(result: unknown, code: ErrorCode): void {
    if (this.isSdkErrorEnvelope(result)) {
      throw new BotError(code, result.error.message ?? 'OpenCode question request failed');
    }
  }

  private isSdkErrorEnvelope(value: unknown): value is SdkErrorEnvelope {
    if (typeof value !== 'object' || value === null || !('error' in value)) {
      return false;
    }
    const result = value as { error?: unknown };
    return result.error !== null && result.error !== undefined;
  }
}
