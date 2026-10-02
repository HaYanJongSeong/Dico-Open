import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionHandler } from './questionHandler.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import type { QuestionClient, QuestionHandlerOptions, QuestionThread } from './questionHandler.js';

interface SentPayload {
  embeds?: { title?: string; description?: string }[];
  content?: string;
}

function createThread(): { thread: QuestionThread; sends: SentPayload[] } {
  const sends: SentPayload[] = [];
  const thread: QuestionThread = {
    send: vi.fn(async (payload: string | SentPayload) => {
      sends.push(typeof payload === 'string' ? { content: payload } : payload);
    }),
  };

  return { thread, sends };
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
    timeoutMs: 60_000,
    ...options,
  });
}

describe('QuestionHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('posts a plain text message with lettered options for question events', async () => {
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
    expect(sends[0]?.content).toContain('a) Yes - Continue the task');
    expect(sends[0]?.content).toContain('b) No - Stop now');
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
    expect(sends).toHaveLength(3);
    expect(sends[1]?.content).toBe('잘못된 답변입니다. 표시된 선택지 중 하나를 선택하세요. *(참조: corr-1)*');
    expect(sends[2]?.content).toContain('**Pick one**');
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
    [{ multiple: false, custom: false }, '선택지의 알파벳 한 글자로 답하세요.'],
    [{ multiple: true, custom: false }, '알파벳을 하나 이상 쉼표로 구분해 답하세요.'],
    [{ multiple: false }, '선택지의 알파벳 한 글자 또는 직접 작성한 답변을 보내세요.'],
    [{ multiple: true }, '알파벳을 하나 이상 쉼표로 구분하거나 직접 답변을 작성하세요.'],
  ])('renders instruction text for %j', async (settings, instruction) => {
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
