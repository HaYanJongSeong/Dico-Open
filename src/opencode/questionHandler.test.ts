import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionHandler } from './questionHandler.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import type {
  QuestionClient,
  QuestionCollector,
  QuestionHandlerOptions,
  QuestionInteraction,
  QuestionMessage,
  QuestionPayload,
  QuestionPollButton,
  QuestionSelectMenu,
  QuestionThread,
} from './questionHandler.js';

type SentPayload = QuestionPayload;

const menuOf = (payload: SentPayload | undefined) => payload?.components?.[0]?.components?.[0] as QuestionSelectMenu | undefined;
const buttonsOf = (payload: SentPayload | undefined) => payload?.components?.[0]?.components as QuestionPollButton[] | undefined;

type TestInteraction = QuestionInteraction & {
  reply: ReturnType<typeof vi.fn>;
  deferUpdate: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
};

class TestMessage implements QuestionMessage {
  public readonly edits: SentPayload[] = [];
  public collectorOptions?: { time: number };
  public readonly collectorStopped = vi.fn();
  private readonly handlers: ((interaction: TestInteraction) => void | Promise<void>)[] = [];

  public createMessageComponentCollector(options: { time: number }): QuestionCollector {
    this.collectorOptions = options;
    const collector: QuestionCollector = {
      on: (event, callback) => {
        if (event === 'collect') this.handlers.push(callback as (interaction: TestInteraction) => void | Promise<void>);
        return collector;
      },
      stop: this.collectorStopped,
    };
    return collector;
  }

  public async edit(payload: QuestionPayload): Promise<unknown> {
    this.edits.push(payload as SentPayload);
    return undefined;
  }

  public async emitSelect(customId: string, values: string[] = [], userId = 'user-1'): Promise<TestInteraction> {
    const interaction = {
      customId,
      values,
      user: { id: userId },
      reply: vi.fn(async () => undefined),
      deferUpdate: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };
    for (const handler of this.handlers) {
      await handler(interaction);
    }
    return interaction;
  }
}

function createThread(): { thread: QuestionThread; sends: SentPayload[]; messages: TestMessage[] } {
  const sends: SentPayload[] = [];
  const messages: TestMessage[] = [];
  const thread: QuestionThread = {
    send: vi.fn(async (payload: string | QuestionPayload) => {
      sends.push(typeof payload === 'string' ? { content: payload } : payload);
      const message = new TestMessage();
      messages.push(message);
      return message;
    }),
  };

  return { thread, sends, messages };
}

function createClient(): QuestionClient {
  return {
    question: {
      reply: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
    },
  };
}

function createHandler(options: Partial<QuestionHandlerOptions> = {}, thread = createThread().thread): QuestionHandler {
  return new QuestionHandler({
    getThread: () => thread,
    getChannelConfig: () => ({}),
    timeoutMs: 60_000,
    ...options,
  });
}

describe('QuestionHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('posts one message per question with poll buttons for legacy question events', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        type: 'question.asked',
        request: {
          id: 'request-1',
          sessionID: 'session-1',
          questions: [
            {
              header: 'Proceed?',
              question: 'Should I continue?',
              options: [
                { label: 'Yes', description: 'Continue the task' },
                { label: 'No', description: 'Stop now' },
              ],
            },
          ],
        },
      },
      client,
    );

    expect(thread.send).toHaveBeenCalledTimes(1);
    expect(sends[0]?.embeds).toBeUndefined();
    expect(sends[0]?.content).toContain('**Proceed?**');
    expect(sends[0]?.content).toContain('Should I continue?');
    expect(buttonsOf(sends[0])?.map((button) => button.label)).toEqual(['Yes', 'No']);
    expect(handler.hasPendingQuestion('thread-1')).toBe(true);
  });

  it('parses letter and text input while collecting multi-question answers sequentially', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [
          {
            header: 'Choose one',
            question: 'Pick an option',
            options: [
              { label: 'Yes', description: 'Approve' },
              { label: 'No', description: 'Decline' },
            ],
            custom: false,
          },
          {
            header: 'Reason',
            question: 'Why?',
            options: [],
            custom: true,
          },
        ],
      },
      client,
    );

    await handler.handleQuestionAnswer('thread-1', 'b');
    await handler.handleQuestionAnswer('thread-1', 'custom');

    expect(sends).toHaveLength(2);
    expect(sends[1]?.content).toContain('**Reason**');
    expect(buttonsOf(sends[0])?.map((button) => button.custom_id)).toEqual(['p:request-1:0:0', 'p:request-1:0:1']);
    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: 'request-1',
      sessionID: 'session-1',
      answer: { '0': 'No', '1': 'custom' },
    });
    expect(client.question.reject).not.toHaveBeenCalled();
    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
  });

  it('rejects and clears pending state when a question times out', async () => {
    vi.useFakeTimers();
    const { thread, sends } = createThread();
    const handler = createHandler({ timeoutMs: 100 }, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [{ header: 'Timeout?', question: 'Answer soon', options: [] }],
      },
      client,
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(client.question.reject).toHaveBeenCalledWith({ requestID: 'request-1', sessionID: 'session-1' });
    expect(client.question.reply).not.toHaveBeenCalled();
    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
    expect(sends.at(-1)?.content).toBe('질문 응답 시간이 만료되었습니다. 에이전트가 답변 없이 계속합니다.');
  });

  it('logs timeout failures instead of allowing unhandled timer rejections', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { thread } = createThread();
    const handler = createHandler({ timeoutMs: 100 }, thread);
    const client = createClient();
    vi.mocked(client.question.reject).mockRejectedValueOnce(new Error('network down'));

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [{ header: 'Timeout?', question: 'Answer soon', options: [] }],
      },
      client,
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('Question timeout handling failed');
  });

  it('re-shows the same question when input is invalid and custom answers are disabled', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [
          {
            header: 'Pick one',
            question: 'Choose',
            options: [{ label: 'Yes', description: 'Approve' }],
            custom: false,
          },
        ],
      },
      client,
    );

    await handler.handleQuestionAnswer('thread-1', 'z', 'corr-1');

    expect(client.question.reply).not.toHaveBeenCalled();
    expect(client.question.reject).not.toHaveBeenCalled();
    expect(sends.at(-1)?.content).toBe('잘못된 답변입니다. 표시된 선택지 중 하나를 선택하세요. *(참조: corr-1)*');
    expect(sends[0]?.content).toContain('**Pick one**');
    expect(handler.hasPendingQuestion('thread-1')).toBe(true);
  });

  it('answers form-backed questions with field keys and option values', async () => {
    const { thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'frm_1',
        sessionID: 'session-1',
        keys: ['tools', 'scope'],
        questions: [
          {
            header: 'Tools',
            question: 'Which tools may run?',
            options: [
              { label: 'shell', description: 'Run commands', value: 'shell' },
              { label: 'write', description: 'Write files', value: 'write' },
            ],
            multiple: true,
          },
          { header: 'Scope', question: 'Where?', options: [], custom: true },
        ],
      },
      client,
    );

    await handler.handleQuestionAnswer('thread-1', 'a,b');
    await handler.handleQuestionAnswer('thread-1', 'src only');

    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: 'frm_1',
      sessionID: 'session-1',
      answer: { tools: ['shell', 'write'], scope: 'src only' },
    });
  });

  it('clears pending state when the question settles elsewhere', async () => {
    const { thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      { id: 'frm_1', sessionID: 'session-1', keys: ['choice'], questions: [{ header: 'Pick', question: 'Choose', options: [{ label: 'Yes', description: 'Approve' }] }] },
      client,
    );
    expect(handler.hasPendingQuestion('thread-1')).toBe(true);

    handler.clearPending('thread-1');

    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
    await handler.handleQuestionAnswer('thread-1', 'a');
    expect(client.question.reply).not.toHaveBeenCalled();
  });

  it('replaces the poll message with the chosen value and no menu hint', async () => {
    const { thread, messages } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'frm_11',
        sessionID: 'session-1',
        keys: ['verdict'],
        questions: [{ header: '투표 확인', question: '고르세요', options: [{ label: '버튼 확인', description: 'a', value: 'yes' }] }],
      },
      client,
    );

    const interaction = await messages[0]?.emitSelect('p:frm_11:0:0');

    const edited = interaction?.editReply.mock.calls[0]?.[0] as SentPayload;
    expect(edited.content).toBe('투표 확인\n고르세요\n✓ _yes_');
    expect(edited.content).not.toContain('누를 버튼을 고르세요.');
    expect(edited.components).toEqual([]);
  });

  it('replaces the select menu message with the chosen value when picking from the menu', async () => {
    const { thread, messages } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    const wide = Array.from({ length: 6 }, (_, index) => ({ label: `옵션 ${index + 1}`, description: '설명', value: `v${index + 1}` }));

    await handler.handleQuestionEvent(
      'thread-1',
      { id: 'frm_12', sessionID: 'session-1', keys: ['choice'], questions: [{ header: '선택', question: '고르세요', options: wide }] },
      client,
    );

    const interaction = await messages[0]?.emitSelect('q:frm_12:0', ['0']);

    const edited = interaction?.editReply.mock.calls[0]?.[0] as SentPayload;
    expect(edited.content).toBe('선택\n고르세요\n✓ _v1_');
    expect(edited.content).not.toContain('하나를 선택하세요.');
  });

  it('posts poll-style buttons for short option lists and submits on click', async () => {
    const { thread, messages, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'frm_6',
        sessionID: 'session-1',
        keys: ['deploy'],
        questions: [{ header: '게시', question: '진행할까요?', options: [{ label: '진행', description: '게시', value: 'yes' }, { label: '보류', description: '보류', value: 'wait' }] }],
      },
      client,
    );

    expect(buttonsOf(sends[0])?.map((button) => button.label)).toEqual(['진행', '보류']);
    expect(buttonsOf(sends[0])?.[0]?.custom_id).toBe('p:frm_6:0:0');
    expect(sends[0]?.content).toContain('누를 버튼을 고르세요.');

    await messages[0]?.emitSelect('p:frm_6:0:1');

    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: 'frm_6', sessionID: 'session-1', answer: { deploy: 'wait' },
    });
  });

  it('adds a submit button for multi-select poll questions', async () => {
    const { thread, messages, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'frm_7',
        sessionID: 'session-1',
        keys: ['tools'],
        questions: [{ header: '도구', question: '어떤 도구?', multiple: true, options: [{ label: 'shell', description: '명령', value: 'shell' }, { label: 'write', description: '쓰기', value: 'write' }] }],
      },
      client,
    );

    expect(sends[0]?.components).toHaveLength(2);
    expect(sends[0]?.components?.[1]?.components?.[0]?.custom_id).toBe('s:frm_7:0');

    await messages[0]?.emitSelect('p:frm_7:0:0');
    await messages[0]?.emitSelect('p:frm_7:0:1');
    expect(client.question.reply).not.toHaveBeenCalled();

    await messages[0]?.emitSelect('s:frm_7:0');

    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: 'frm_7', sessionID: 'session-1', answer: { tools: ['shell', 'write'] },
    });
  });

  it('falls back to the select menu when options exceed the poll button limit', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    const options = Array.from({ length: 6 }, (_, index) => ({ label: `옵션 ${index + 1}`, description: '설명', value: `v${index + 1}` }));

    await handler.handleQuestionEvent(
      'thread-1',
      { id: 'frm_8', sessionID: 'session-1', keys: ['choice'], questions: [{ header: '선택', question: '고르세요', options }] },
      client,
    );

    expect(menuOf(sends[0])?.custom_id).toBe('q:frm_8:0');
    expect(sends[0]?.content).toContain('하나를 선택하세요.');
  });

  it('posts a select menu per question and submits option values on selection', async () => {
    const { thread, messages, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    const wide = Array.from({ length: 6 }, (_, index) => ({ label: `옵션 ${index + 1}`, description: '설명', value: `v${index + 1}` }));

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'frm_1',
        sessionID: 'session-1',
        keys: ['deploy', 'scope'],
        questions: [
          { header: '게시', question: '진행할까요?', options: wide },
          { header: '범위', question: '어디에?', options: wide },
        ],
      },
      client,
    );

    expect(sends).toHaveLength(2);
    expect(menuOf(sends[0])?.custom_id).toBe('q:frm_1:0');
    expect(menuOf(sends[0])?.options?.map((option) => option.value)).toEqual(['0', '1', '2', '3', '4', '5', 'other']);
    expect(menuOf(sends[1])?.custom_id).toBe('q:frm_1:1');

    await messages[0]?.emitSelect('q:frm_1:0', ['1']);

    expect(client.question.reply).not.toHaveBeenCalled();
    await messages[1]?.emitSelect('q:frm_1:1', ['0']);

    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: 'frm_1', sessionID: 'session-1', answer: { deploy: 'v2', scope: 'v1' },
    });
    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
  });

  it('maps multi-select menu values to a list of option values', async () => {
    const { thread, messages, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    const wide = Array.from({ length: 6 }, (_, index) => ({ label: `옵션 ${index + 1}`, description: '설명', value: `v${index + 1}` }));

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'frm_2',
        sessionID: 'session-1',
        keys: ['tools'],
        questions: [{ header: '도구', question: '어떤 도구?', multiple: true, options: wide }],
      },
      client,
    );

    expect(menuOf(sends[0])?.max_values).toBe(7);

    await messages[0]?.emitSelect('q:frm_2:0', ['0', '1']);

    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: 'frm_2', sessionID: 'session-1', answer: { tools: ['v1', 'v2'] },
    });
  });

  it('keeps the question pending when "other" is chosen so chat can supply the answer', async () => {
    const { thread, messages } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      { id: 'frm_4', sessionID: 'session-1', keys: ['scope'], questions: [{ header: 'Scope', question: 'Where?', options: [{ label: 'src', description: '소스', value: 'src' }] }] },
      client,
    );

    await messages[0]?.emitSelect('q:frm_4:0', ['other']);

    expect(handler.hasPendingQuestion('thread-1')).toBe(true);
    expect(client.question.reply).not.toHaveBeenCalled();

    await handler.handleQuestionAnswer('thread-1', 'src only');

    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: 'frm_4', sessionID: 'session-1', answer: { scope: 'src only' },
    });
  });

  it('ignores select menu picks from users outside the channel allowlist', async () => {
    const { thread, messages } = createThread();
    const handler = createHandler({ getChannelConfig: () => ({ allowedUsers: ['user-1'] }) }, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      { id: 'frm_3', sessionID: 'session-1', questions: [{ header: 'Pick', question: 'Choose', options: [{ label: 'Yes', description: 'ok' }] }] },
      client,
    );

    const interaction = await messages[0]?.emitSelect('q:frm_3:0', ['0'], 'user-2');

    expect(interaction?.reply).toHaveBeenCalled();
    expect(client.question.reply).not.toHaveBeenCalled();
  });

  it('disables the chat escape hatch when custom input is not allowed', async () => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      { id: 'frm_5', sessionID: 'session-1', keys: ['choice'], questions: [{ header: 'Pick', question: 'Choose', custom: false, options: [{ label: 'Yes', description: 'ok', value: 'yes' }] }] },
      client,
    );

    expect(buttonsOf(sends[0])?.map((button) => button.label)).toEqual(['Yes']);
    expect(sends[0]?.content).not.toContain('직접 입력');
  });

  it('rejects visibly when final question reply returns an SDK error envelope', async () => {
    const { thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    vi.mocked(client.question.reply).mockResolvedValueOnce({ error: { message: 'request expired' } });

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [{ header: 'Pick one', question: 'Choose', options: [{ label: 'Yes', description: 'Approve' }] }],
      },
      client,
    );

    await expect(handler.handleQuestionAnswer('thread-1', 'a')).rejects.toMatchObject({
      code: ErrorCode.QUESTION_INVALID_ANSWER,
      message: 'request expired',
    });
    expect(handler.hasPendingQuestion('thread-1')).toBe(true);
  });

  it('rejects visibly when missing-thread rejection returns an SDK error envelope', async () => {
    const handler = createHandler({ getThread: () => undefined });
    const client = createClient();
    vi.mocked(client.question.reject).mockResolvedValueOnce({ error: { message: 'request expired' } });

    await expect(
      handler.handleQuestionEvent(
        'thread-1',
        {
          id: 'request-1',
          sessionID: 'session-1',
          questions: [{ header: 'Pick one', question: 'Choose', options: [] }],
        },
        client,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.QUESTION_TIMEOUT, message: 'request expired' });
    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
  });

  it.each([
    [{ multiple: false, custom: false }, '누를 버튼을 고르세요.', 1, ['Yes']],
    [{ multiple: true, custom: false }, '필요한 항목을 고른 뒤 답변 제출을 누르세요.', 2, ['Yes']],
    [{ multiple: false }, '누를 버튼을 고르세요.', 1, ['Yes']],
    [{ multiple: true }, '필요한 항목을 고른 뒤 답변 제출을 누르세요.', 2, ['Yes']],
  ])('renders poll hints for %j', async (settings, instruction, expectedRows, expectedLabels) => {
    const { thread, sends } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handleQuestionEvent(
      'thread-1',
      {
        id: 'request-1',
        sessionID: 'session-1',
        questions: [
          {
            header: 'Pick',
            question: 'Choose',
            options: [{ label: 'Yes', description: 'Approve' }],
            ...settings,
          },
        ],
      },
      client,
    );

    expect(sends[0]?.content).toContain(instruction);
    expect(sends[0]?.components).toHaveLength(expectedRows);
    expect(buttonsOf(sends[0])?.map((button) => button.label)).toEqual(expectedLabels);
  });

  it('offers the direct-input row only when custom input is allowed on the select menu', async () => {
    const withCustom = createThread();
    const withoutCustom = createThread();
    const client = createClient();
    const options = Array.from({ length: 6 }, (_, index) => ({ label: `옵션 ${index + 1}`, description: '설명', value: `v${index + 1}` }));

    await createHandler({}, withCustom.thread).handleQuestionEvent(
      'thread-1',
      { id: 'frm_9', sessionID: 'session-1', questions: [{ header: '선택', question: '고르세요', options }] },
      client,
    );
    await createHandler({}, withoutCustom.thread).handleQuestionEvent(
      'thread-2',
      { id: 'frm_10', sessionID: 'session-1', questions: [{ header: '선택', question: '고르세요', custom: false, options }] },
      client,
    );

    expect(menuOf(withCustom.sends[0])?.options?.map((option) => option.value)).toContain('other');
    expect(menuOf(withoutCustom.sends[0])?.options?.map((option) => option.value)).not.toContain('other');
  });

  it('rejects unsupported questions with more than 26 options before posting', async () => {
    const { thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    const options = Array.from({ length: 27 }, (_, index) => ({ label: `Option ${index + 1}`, description: 'Choice' }));

    await expect(
      handler.handleQuestionEvent(
        'thread-1',
        {
          id: 'request-1',
          sessionID: 'session-1',
          questions: [{ header: 'Pick', question: 'Choose', options }],
        },
        client,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.QUESTION_INVALID_ANSWER });
    await expect(
      handler.handleQuestionEvent(
        'thread-1',
        {
          id: 'request-2',
          sessionID: 'session-1',
          questions: [{ header: 'Pick', question: 'Choose', options }],
        },
        client,
      ),
    ).rejects.toBeInstanceOf(BotError);
    expect(client.question.reject).toHaveBeenCalledWith({ requestID: 'request-1', sessionID: 'session-1' });
    expect(thread.send).not.toHaveBeenCalled();
    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
  });

  it('rejects malformed question entries before posting', async () => {
    const { thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await expect(
      handler.handleQuestionEvent(
        'thread-1',
        {
          id: 'request-1',
          sessionID: 'session-1',
          questions: [{ header: 'Pick', question: 'Choose' }],
        },
        client,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.QUESTION_INVALID_ANSWER });

    expect(client.question.reject).toHaveBeenCalledWith({ requestID: 'request-1', sessionID: 'session-1' });
    expect(thread.send).not.toHaveBeenCalled();
    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
  });

  it('rejects falsy malformed question entries before posting', async () => {
    const { thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await expect(
      handler.handleQuestionEvent(
        'thread-1',
        {
          id: 'request-1',
          sessionID: 'session-1',
          questions: [null],
        },
        client,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.QUESTION_INVALID_ANSWER });

    expect(client.question.reject).toHaveBeenCalledWith({ requestID: 'request-1', sessionID: 'session-1' });
    expect(thread.send).not.toHaveBeenCalled();
    expect(handler.hasPendingQuestion('thread-1')).toBe(false);
  });
});
