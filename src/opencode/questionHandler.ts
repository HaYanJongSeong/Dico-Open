import { MessageFlags } from 'discord.js';
import { suppressLinkPreviews } from '../discord/messageOptions.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_LETTERED_OPTIONS = 26;
/** Discord allows 25 options per select menu; one slot is reserved for the chat escape hatch. */
const DISCORD_SELECT_OPTION_LIMIT = 25;
const OTHER_OPTION_VALUE = 'other';
/** Discord allows 5 buttons per action row; poll buttons are used for short option lists only. */
const DISCORD_BUTTONS_PER_ROW = 5;
const DISCORD_POLL_BUTTON_LIMIT = 5;
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

/** Discord message payload that may carry a question select menu. */
export interface QuestionPayload {
  embeds?: unknown[];
  components?: QuestionActionRow[];
  content?: string;
  flags?: number;
}

/** Discord action row holding a select menu or poll buttons. */
export interface QuestionActionRow {
  type: 1;
  components: (QuestionSelectMenu | QuestionPollButton)[];
}

/** Discord string select menu for one question. */
export interface QuestionSelectMenu {
  type: 3;
  custom_id: string;
  placeholder: string;
  options: QuestionSelectOption[];
  min_values: number;
  max_values: number;
}

/** Discord button used for poll-style answering. */
export interface QuestionPollButton {
  type: 2;
  custom_id: string;
  label: string;
  style: 1 | 2;
}

/** One selectable choice; `value` is the option index or `other`. */
export interface QuestionSelectOption {
  label: string;
  value: string;
  description?: string;
}

/** Discord thread subset required by question handling. */
export interface QuestionThread {
  /**
   * Send a message or embed payload to the thread.
   * @param payload - Message content or embed payload.
   * @returns Discord API send result.
   */
  send(payload: string | QuestionPayload): Promise<QuestionMessage>;
}

/** Discord message returned for a posted question. */
export interface QuestionMessage {
  /**
   * Create a collector for question button clicks.
   * @param options - Collector timeout options.
   * @returns Component collector.
   */
  createMessageComponentCollector?(options: { time: number }): QuestionCollector;

  /**
   * Replace the question message after answering or timeout.
   * @param payload - Replacement message payload.
   * @returns Discord API edit result.
   */
  edit?(payload: QuestionPayload): Promise<unknown>;
}

/** Discord component collector subset required by question handling. */
export interface QuestionCollector {
  /**
   * Register a collect handler for button clicks.
   * @param event - Collector event name.
   * @param callback - Handler invoked with the collected interaction.
   * @returns This collector.
   */
  on(event: 'collect', callback: (interaction: QuestionInteraction) => void | Promise<void>): QuestionCollector;

  /**
   * Stop the collector once the question is answered.
   * @param reason - Optional stop reason.
   * @returns Nothing.
   */
  stop?(reason?: string): void;
}

/** Discord select-menu interaction subset required by question handling. */
export interface QuestionInteraction {
  customId: string;
  /** Selected option values, in the order the user picked them. */
  values: string[];
  user?: { id: string };
  reply?(payload: { content: string; flags: number }): Promise<unknown>;
  deferUpdate?(): Promise<unknown>;
  editReply?(payload: QuestionPayload): Promise<unknown>;
}

/** Channel configuration consulted before answering a question by button. */
export interface QuestionChannelConfig {
  allowedUsers?: string[];
}

/** Options for constructing a question handler. */
export interface QuestionHandlerOptions {
  /**
   * Resolve a Discord thread by ID.
   * @param threadId - Discord thread ID.
   * @returns Thread when available, otherwise undefined.
   */
  getThread(threadId: string): QuestionThread | undefined;

  /**
   * Resolve channel configuration by Discord thread ID.
   * @param threadId - Discord thread ID.
   * @returns Channel config when available, otherwise undefined.
   */
  getChannelConfig?(threadId: string): QuestionChannelConfig | undefined;
  timeoutMs?: number;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

interface PendingQuestionState {
  client: QuestionClient;
  threadId: string;
  requestID: string;
  sessionID: string;
  keys?: string[];
  questions: QuestionInfo[];
  currentIndex: number;
  /** Answers indexed by question; a slot stays undefined until answered. */
  collectedAnswers: (string[] | undefined)[];
  timer?: unknown;
  messages: Map<number, QuestionMessage>;
  collectors: (QuestionCollector | undefined)[];
  /** Question index waiting for a typed chat answer after choosing `other`. */
  awaitingChatAnswer?: number;
  /** Guards against a second submit while the first one is in flight. */
  submitting?: boolean;
  /** Poll-button selections per question index, holding option values. */
  pollSelections: string[][];
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
      threadId,
      requestID: request.id,
      sessionID: request.sessionID,
      keys: request.keys,
      questions: request.questions,
      currentIndex: 0,
      collectedAnswers: new Array<string[] | undefined>(request.questions.length).fill(undefined),
      messages: new Map(),
      collectors: new Array<QuestionCollector | undefined>(request.questions.length).fill(undefined),
      pollSelections: Array.from({ length: request.questions.length }, () => [] as string[]),
    };
    this.pending.set(threadId, state);
    this.resetTimer(threadId, state);
    for (let index = 0; index < request.questions.length; index += 1) {
      state.currentIndex = index;
      await this.showCurrentQuestion(thread, state);
    }
    state.currentIndex = 0;
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

    // A typed answer targets the question picked via `other`, else the first unanswered one.
    const index = state.awaitingChatAnswer ?? state.collectedAnswers.findIndex((answer) => answer === undefined);
    const question = index >= 0 ? state.questions[index] : undefined;
    if (index === undefined || index < 0 || !question) {
      return;
    }
    if (state.collectedAnswers[index]) {
      return;
    }

    const answers = this.parseAnswer(question, content);
    if (!answers) {
      const suffix = correlationId ? ` *(참조: ${correlationId})*` : '';
      await thread.send(suppressLinkPreviews(`잘못된 답변입니다. 표시된 선택지 중 하나를 선택하세요.${suffix}`));
      return;
    }

    state.awaitingChatAnswer = undefined;
    this.recordAnswer(state, index, answers);
    await state.messages.get(index)?.edit?.({ content: this.answerContent(question, answers), components: [] });
    await this.submitIfComplete(state);
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
    for (const collector of state?.collectors ?? []) {
      collector?.stop?.('cleared');
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
    for (const collector of state.collectors) {
      collector?.stop?.('time');
    }
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

    const menu = this.createMenu(question, state.currentIndex, state.requestID);
    if (!menu) {
      await thread.send(suppressLinkPreviews(this.formatQuestion(question)));
      return;
    }

    // Short option lists get poll-style buttons; long ones fall back to the select menu.
    const pollRows = this.createPollButtons(question, state.currentIndex, state.requestID);
    const rows = pollRows ?? [{ type: 1, components: [menu] } as QuestionActionRow];
    const message = await thread.send(suppressLinkPreviews({
      content: this.formatMenuQuestion(question, pollRows !== undefined),
      components: rows,
    }));
    state.messages.set(state.currentIndex, message);
    this.collectMenu(state, message, question, state.currentIndex);
  }

  /** Poll-style buttons for short option lists; a submit button closes multi-select. */
  private createPollButtons(question: QuestionInfo, index: number, requestID: string): QuestionActionRow[] | undefined {
    if (question.options.length === 0 || question.options.length > DISCORD_POLL_BUTTON_LIMIT) {
      return undefined;
    }

    const rows: QuestionActionRow[] = [];
    for (let start = 0; start < question.options.length; start += DISCORD_BUTTONS_PER_ROW) {
      rows.push({
        type: 1,
        components: question.options.slice(start, start + DISCORD_BUTTONS_PER_ROW).map((option, offset) => ({
          type: 2,
          custom_id: `p:${requestID}:${index}:${start + offset}`,
          label: (option.label || `선택지 ${start + offset + 1}`).slice(0, 80),
          style: 2,
        })),
      });
    }

    if (question.multiple) {
      rows.push({
        type: 1,
        components: [{ type: 2, custom_id: `s:${requestID}:${index}`, label: '답변 제출', style: 1 }],
      });
    }

    return rows;
  }

  /** Create one select menu; options are capped at Discord's 25-item limit. */
  private createMenu(question: QuestionInfo, index: number, requestID: string): QuestionSelectMenu | undefined {
    if (question.options.length === 0) {
      return undefined;
    }

    const options: QuestionSelectOption[] = question.options.slice(0, DISCORD_SELECT_OPTION_LIMIT).map((option, optionIndex) => ({
      label: option.label.slice(0, 100) || `선택지 ${optionIndex + 1}`,
      value: String(optionIndex),
      description: option.description.slice(0, 100),
    }));
    if (question.custom !== false && options.length < DISCORD_SELECT_OPTION_LIMIT) {
      options.push({ label: '직접 입력', value: OTHER_OPTION_VALUE, description: '스레드에 답변을 직접 입력합니다.' });
    }

    return {
      type: 3,
      custom_id: `q:${requestID}:${index}`,
      placeholder: '답변을 선택하세요',
      options,
      min_values: 1,
      max_values: question.multiple ? options.length : 1,
    };
  }

  private parseMenuId(customId: string): { requestID: string; index: number } | undefined {
    const parts = customId.split(':');
    if (parts.length !== 3 || parts[0] !== 'q') {
      return undefined;
    }
    const index = Number(parts[2]);
    return Number.isInteger(index) ? { requestID: parts[1] ?? '', index } : undefined;
  }

  /** Route one collected interaction to the select-menu or poll-button handler. */
  private async handleInteraction(state: PendingQuestionState, question: QuestionInfo, index: number, interaction: QuestionInteraction): Promise<void> {
    if (this.pending.get(state.threadId) !== state) {
      return;
    }
    if (interaction.customId.startsWith('q:')) {
      await this.handleMenu(state, question, index, interaction);
      return;
    }
    await this.handlePollClick(state, question, index, interaction);
  }

  private collectMenu(state: PendingQuestionState, message: QuestionMessage, question: QuestionInfo, index: number): void {
    const collector = message.createMessageComponentCollector?.({ time: this.timeoutMs });
    if (!collector) {
      return;
    }

    state.collectors[index] = collector;
    collector.on('collect', (interaction) => this.handleInteraction(state, question, index, interaction).catch((error: unknown) => {
      logger.warn('Question input handling failed', { requestID: state.requestID, error });
    }));
  }

  private async handlePollClick(state: PendingQuestionState, question: QuestionInfo, index: number, interaction: QuestionInteraction): Promise<void> {
    const config = this.options.getChannelConfig?.(state.threadId);
    if (!config || !interaction.user || (config.allowedUsers?.length && !config.allowedUsers.includes(interaction.user.id))) {
      await interaction.reply?.({ content: '이 질문에 답할 수 없습니다.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (state.collectedAnswers[index]) {
      await interaction.reply?.({ content: '이미 답변한 질문입니다.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.customId.startsWith('s:')) {
      const answers = [...(state.pollSelections[index] ?? [])];
      if (answers.length === 0) {
        await interaction.reply?.({ content: '선택한 항목이 없습니다. 먼저 항목을 선택하세요.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate?.();
      this.recordAnswer(state, index, answers);
      await interaction.editReply?.({ content: this.answerContent(question, answers), components: [] });
      await this.submitIfComplete(state);
      return;
    }

    const parts = interaction.customId.split(':');
    const optionIndex = parts[0] === 'p' && parts[3] !== undefined ? Number(parts[3]) : Number.NaN;
    const option = question.options[optionIndex];
    if (!option) {
      return;
    }

    const chosen = state.pollSelections[index] ?? [];
    const value = option.value ?? option.label;
    const next = chosen.includes(value)
      ? chosen.filter((entry) => entry !== value)
      : [...chosen, value];
    state.pollSelections[index] = next;

    if (!question.multiple) {
      await interaction.deferUpdate?.();
      this.recordAnswer(state, index, [value]);
      await interaction.editReply?.({ content: this.answerContent(question, [value]), components: [] });
      await this.submitIfComplete(state);
      return;
    }

    // ponytail: toggles only surface in the ephemeral notice; reflowing rows would need a message rebuild.
    await interaction.reply?.({
      content: next.length === 0 ? '선택을 모두 해제했습니다.' : `선택: ${next.join(', ')} — 답변 제출을 누르세요.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleMenu(state: PendingQuestionState, question: QuestionInfo, index: number, interaction: QuestionInteraction): Promise<void> {
    if (this.pending.get(state.threadId) !== state) {
      return;
    }

    const config = this.options.getChannelConfig?.(state.threadId);
    if (!config || !interaction.user || (config.allowedUsers?.length && !config.allowedUsers.includes(interaction.user.id))) {
      await interaction.reply?.({ content: '이 질문에 답할 수 없습니다.', flags: MessageFlags.Ephemeral });
      return;
    }

    const parsed = this.parseMenuId(interaction.customId);
    if (!parsed || parsed.requestID !== state.requestID || parsed.index !== index || state.collectedAnswers[index]) {
      await interaction.reply?.({ content: '이미 답변했거나 만료된 질문입니다.', flags: MessageFlags.Ephemeral });
      return;
    }

    const other = interaction.values.includes(OTHER_OPTION_VALUE);
    if (other) {
      await interaction.deferUpdate?.();
      state.awaitingChatAnswer = index;
      return;
    }

    const answers = this.mapSelectedValues(question, interaction.values);
    if (!answers) {
      await interaction.reply?.({ content: '선택지를 다시 선택하세요.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate?.();
    this.recordAnswer(state, index, answers);
    await interaction.editReply?.({ content: this.answerContent(question, answers), components: [] });
    await this.submitIfComplete(state);
  }

  private mapSelectedValues(question: QuestionInfo, values: string[]): string[] | undefined {
    const answers: string[] = [];
    for (const value of values) {
      if (value === OTHER_OPTION_VALUE) {
        return undefined;
      }
      const option = question.options[Number(value)];
      if (!option) {
        return undefined;
      }
      answers.push(option.value ?? option.label);
    }
    return answers.length > 0 ? answers : undefined;
  }

  private recordAnswer(state: PendingQuestionState, index: number, answers: string[]): void {
    state.collectedAnswers[index] = answers;
    const collector = state.collectors[index];
    collector?.stop?.('answered');
    state.collectors[index] = undefined;
  }

  /** Answered message body: question context plus the recorded choice. */
  private answerContent(question: QuestionInfo | undefined, answers: string[]): string {
    const context = question === undefined ? '' : `${question.header}\n${question.question}\n`;
    return `${context}✓ _${answers.join(', ')}_`;
  }

  private async submitIfComplete(state: PendingQuestionState): Promise<void> {
    if (state.submitting || state.collectedAnswers.filter(Boolean).length < state.questions.length) {
      return;
    }
    // Keep pending state until OpenCode accepts the reply so a failed submit can be retried.
    state.submitting = true;
    try {
      this.assertNoSdkError(
        await state.client.question.reply({
          requestID: state.requestID,
          sessionID: state.sessionID,
          answer: this.buildAnswerMap(state),
        }),
        ErrorCode.QUESTION_INVALID_ANSWER,
      );
    } catch (error) {
      state.submitting = false;
      throw error;
    }
    this.clearPending(state.threadId);
  }

  private formatMenuQuestion(question: QuestionInfo, isPoll = false): string {
    const hint = isPoll
      ? (question.multiple ? '필요한 항목을 고른 뒤 답변 제출을 누르세요.' : '누를 버튼을 고르세요.')
      : (question.multiple ? '여러 개를 선택할 수 있습니다.' : '하나를 선택하세요.');
    const chat = question.custom === false ? '' : '\n스레드에 알파벳이나 답변을 직접 입력해도 됩니다.';
    return `**${question.header}**\n${question.question}\n${hint}${chat}`;
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
