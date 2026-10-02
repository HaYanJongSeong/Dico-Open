import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionHandler } from './permissionHandler.js';
import type {
  PermissionClient,
  PermissionCollector,
  PermissionHandlerOptions,
  PermissionInteraction,
  PermissionMessage,
  PermissionThread,
} from './permissionHandler.js';

interface SentPayload {
  embeds?: { title?: string; description?: string }[];
  components?: { components?: { custom_id?: string; label?: string; style?: number; type?: number }[]; type?: number }[];
  content?: string;
}

const permissionButtons = [
  {
    type: 1,
    components: [
      { type: 2, custom_id: 'allow_once', label: '한 번 허용', style: 1 },
      { type: 2, custom_id: 'allow_always', label: '항상 허용', style: 3 },
      { type: 2, custom_id: 'reject', label: '거부', style: 4 },
    ],
  },
];

type TestInteraction = PermissionInteraction & {
  update: (payload: { embeds?: unknown[]; components?: unknown[]; content?: string }) => Promise<unknown>;
};

class TestCollector implements PermissionCollector {
  private readonly collectHandlers: ((interaction: TestInteraction) => void | Promise<void>)[] = [];
  private readonly endHandlers: ((collected: unknown, reason: string) => void | Promise<void>)[] = [];
  public readonly stop = vi.fn((reason?: string) => {
    this.emitEnd(reason ?? 'user');
  });

  public on(event: 'collect', callback: (interaction: TestInteraction) => void | Promise<void>): PermissionCollector;
  public on(event: 'end', callback: (collected: unknown, reason: string) => void | Promise<void>): PermissionCollector;
  public on(event: 'collect' | 'end', callback: ((interaction: TestInteraction) => void | Promise<void>) | ((collected: unknown, reason: string) => void | Promise<void>)): PermissionCollector {
    if (event === 'collect') {
      this.collectHandlers.push(callback as (interaction: TestInteraction) => void | Promise<void>);
    } else {
      this.endHandlers.push(callback as (collected: unknown, reason: string) => void | Promise<void>);
    }

    return this;
  }

  public async emitCollect(customId: string, userId = 'user-1'): Promise<TestInteraction> {
    const interaction = { customId, user: { id: userId }, update: vi.fn(async () => undefined), reply: vi.fn(async () => undefined) };
    for (const handler of this.collectHandlers) {
      await handler(interaction);
    }
    return interaction;
  }

  public async emitEnd(reason = 'time'): Promise<void> {
    for (const handler of this.endHandlers) {
      await handler([], reason);
    }
  }
}

function createClient(): PermissionClient {
  return {
    permission: {
      reply: vi.fn(async () => undefined),
    },
  };
}

function createThread(collector = new TestCollector()): { collector: TestCollector; sends: SentPayload[]; thread: PermissionThread } {
  const sends: SentPayload[] = [];
  const message: PermissionMessage = {
    createMessageComponentCollector: vi.fn(() => collector),
    edit: vi.fn(async (payload: SentPayload) => {
      sends.push(payload);
    }),
  };
  const thread: PermissionThread = {
    send: vi.fn(async (payload: string | SentPayload) => {
      sends.push(typeof payload === 'string' ? { content: payload } : payload);
      return message;
    }),
  };

  return { collector, sends, thread };
}

function createHandler(options: Partial<PermissionHandlerOptions> = {}, thread = createThread().thread): PermissionHandler {
  return new PermissionHandler({
    getThread: () => thread,
    getChannelConfig: () => ({ permissions: 'interactive' }),
    timeoutMs: 60_000,
    ...options,
  });
}

describe('PermissionHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('immediately replies always in auto mode without sending a Discord message', async () => {
    const { thread } = createThread();
    const handler = createHandler({ getChannelConfig: () => ({ permissions: 'auto' }) }, thread);
    const client = createClient();

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['npm test'] },
      client,
    );

    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'request-1', reply: 'always' });
    expect(thread.send).not.toHaveBeenCalled();
  });

  it('accepts current CLI v2 action and resources permission payloads', async () => {
    const { thread } = createThread();
    const handler = createHandler({ getChannelConfig: () => ({ permissions: 'auto' }) }, thread);
    const reply = vi.fn(async () => undefined);
    const client = { permission: { reply: vi.fn() }, v2Root: { session: { permission: { reply } } } } as PermissionClient;

    await handler.handlePermissionEvent('thread-1', {
      id: 'request-1', sessionID: 'session-1', action: 'shell', resources: ['pnpm test'], save: ['pnpm test'],
    }, client);

    expect(reply).toHaveBeenCalledWith({ sessionID: 'session-1', requestID: 'request-1', reply: 'always' });
    expect(thread.send).not.toHaveBeenCalled();
  });

  it('posts an embed with Discord API-compatible allow and reject buttons in interactive mode', async () => {
    const { sends, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handlePermissionEvent(
      'thread-1',
      {
        type: 'permission.asked',
        request: { id: 'request-1', sessionID: 'session-1', permission: 'edit', patterns: ['src/**/*.ts'] },
      },
      client,
    );

    expect(thread.send).toHaveBeenCalledTimes(1);
    expect(sends[0]?.embeds?.[0]?.title).toBe('권한 요청');
    expect(sends[0]?.embeds?.[0]?.description).toContain('edit');
    expect(sends[0]?.embeds?.[0]?.description).toContain('src/**/*.ts');
    expect(sends[0]?.components).toEqual(permissionButtons);
  });

  it('rejects the permission request when posting the interactive prompt fails', async () => {
    const thread: PermissionThread = {
      send: vi.fn(async () => {
        throw new Error('missing permissions');
      }),
    };
    const handler = createHandler({}, thread);
    const client = createClient();

    await expect(
      handler.handlePermissionEvent(
        'thread-1',
        { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
        client,
      ),
    ).resolves.toBeUndefined();

    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'request-1', reply: 'reject' });
  });

  it('contains fallback reject failures after interactive prompt posting fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const thread: PermissionThread = {
      send: vi.fn(async () => {
        throw new Error('missing permissions');
      }),
    };
    const handler = createHandler({}, thread);
    const client = createClient();
    vi.mocked(client.permission.reply).mockRejectedValueOnce(new Error('network down'));

    await expect(
      handler.handlePermissionEvent(
        'thread-1',
        { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
        client,
      ),
    ).resolves.toBeUndefined();

    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'request-1', reply: 'reject' });
    expect(warn.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.stringContaining('Permission prompt posting failed'),
      expect.stringContaining('Permission prompt fallback reject failed'),
    ]));
  });

  it.each([
    ['allow_once', 'once'],
    ['allow_always', 'always'],
    ['reject', 'reject'],
  ] as const)('replies %s button clicks as %s', async (customId, reply) => {
    const { collector, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    const interaction = await collector.emitCollect(customId);

    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'request-1', reply });
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    expect(collector.stop).toHaveBeenCalledWith('answered');
  });

  it('does not let a disallowed user approve an interactive permission', async () => {
    const { collector, thread } = createThread();
    const handler = createHandler({ getChannelConfig: () => ({ permissions: 'interactive', allowedUsers: ['user-1'] }) }, thread);
    const client = createClient();
    await handler.handlePermissionEvent('thread-1', { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: [] }, client);
    const interaction = await collector.emitCollect('allow_always', 'outsider');
    expect(client.permission.reply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalled();
    await collector.emitCollect('allow_once', 'user-1');
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'request-1', reply: 'once' });
  });

  it('rejects and posts a timeout notice when the collector times out', async () => {
    const { collector, sends, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    await collector.emitEnd('time');

    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'request-1', reply: 'reject' });
    expect(sends.at(-1)?.content).toBe('권한 요청 시간이 만료되어 거부했습니다.');
  });

  it('contains button reply rejections and updates the interaction with a failure notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { collector, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    vi.mocked(client.permission.reply).mockRejectedValueOnce(new Error('network down'));

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    const interaction = await collector.emitCollect('allow_once');

    expect(interaction.update).toHaveBeenCalledWith({ content: '권한 응답에 실패했습니다. 다시 시도하세요.', components: permissionButtons });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('Permission interaction handling failed');
  });

  it('keeps a rejected button reply pending so a later button click can answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { collector, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    vi.mocked(client.permission.reply).mockRejectedValueOnce(new Error('network down'));

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    const failedInteraction = await collector.emitCollect('allow_once');
    expect(failedInteraction.update).toHaveBeenCalledWith({ content: '권한 응답에 실패했습니다. 다시 시도하세요.', components: permissionButtons });

    const retryInteraction = await collector.emitCollect('reject');

    expect(client.permission.reply).toHaveBeenCalledTimes(2);
    expect(client.permission.reply).toHaveBeenNthCalledWith(2, { requestID: 'request-1', reply: 'reject' });
    expect(retryInteraction.update).toHaveBeenCalledWith({ content: '권한을 거부했습니다.', components: [] });
    expect(collector.stop).toHaveBeenCalledWith('answered');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate button clicks while a reply is in flight', async () => {
    const { collector, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    let resolveReply: ((value: unknown) => void) | undefined;
    vi.mocked(client.permission.reply).mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolveReply = resolve;
        }),
    );

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    const firstInteractionPromise = collector.emitCollect('allow_once');
    const duplicateInteraction = await collector.emitCollect('reject');

    expect(client.permission.reply).toHaveBeenCalledTimes(1);
    expect(duplicateInteraction.update).not.toHaveBeenCalled();

    resolveReply?.(undefined);
    const firstInteraction = await firstInteractionPromise;
    await vi.waitFor(() => {
      expect(firstInteraction.update).toHaveBeenCalledWith({ content: '권한을 한 번 허용했습니다.', components: [] });
    });
  });

  it('does not timeout reject when an in-flight button reply later succeeds', async () => {
    const { collector, sends, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    let resolveReply: ((value: unknown) => void) | undefined;
    vi.mocked(client.permission.reply).mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolveReply = resolve;
        }),
    );

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    const interactionPromise = collector.emitCollect('allow_once');

    await collector.emitEnd('time');

    expect(client.permission.reply).toHaveBeenCalledTimes(1);
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'request-1', reply: 'once' });
    expect(sends.at(-1)?.content).not.toBe('권한 요청 시간이 만료되어 거부했습니다.');

    resolveReply?.(undefined);
    const interaction = await interactionPromise;
    await vi.waitFor(() => {
      expect(interaction.update).toHaveBeenCalledWith({ content: '권한을 한 번 허용했습니다.', components: [] });
    });
    expect(client.permission.reply).toHaveBeenCalledTimes(1);
  });

  it('timeout rejects once when an in-flight button reply fails after timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { collector, sends, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    let rejectReply: ((error: unknown) => void) | undefined;
    vi.mocked(client.permission.reply)
      .mockImplementationOnce(
        async () =>
          new Promise((_resolve, reject) => {
            rejectReply = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    const interactionPromise = collector.emitCollect('allow_once');

    await collector.emitEnd('time');

    expect(client.permission.reply).toHaveBeenCalledTimes(1);
    rejectReply?.(new Error('network down'));
    await interactionPromise;
    await vi.waitFor(() => {
      expect(client.permission.reply).toHaveBeenCalledTimes(2);
    });

    expect(client.permission.reply).toHaveBeenNthCalledWith(2, { requestID: 'request-1', reply: 'reject' });
    expect(sends.at(-1)?.content).toBe('권한 요청 시간이 만료되어 거부했습니다.');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('contains button SDK error envelopes and updates the interaction with a failure notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { collector, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    vi.mocked(client.permission.reply).mockResolvedValueOnce({ error: { message: 'failed' } });

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    const interaction = await collector.emitCollect('allow_once');

    expect(interaction.update).toHaveBeenCalledWith({ content: '권한 응답에 실패했습니다. 다시 시도하세요.', components: permissionButtons });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('Permission interaction handling failed');
  });

  it('contains timeout reply failures and edits the message with a failure notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { collector, sends, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    vi.mocked(client.permission.reply).mockRejectedValueOnce(new Error('network down'));

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    await collector.emitEnd('time');

    expect(sends.at(-1)?.content).toBe('권한 요청 시간 만료 처리에 실패했습니다. 다시 시도하세요.');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('Permission timeout handling failed');
  });

  it('contains timeout SDK error envelopes and edits the message with a failure notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { collector, sends, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    vi.mocked(client.permission.reply).mockResolvedValueOnce({ error: { message: 'failed' } });

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    await collector.emitEnd('time');

    expect(sends.at(-1)?.content).toBe('권한 요청 시간 만료 처리에 실패했습니다. 다시 시도하세요.');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('Permission timeout handling failed');
  });

  it('keeps an SDK error button reply pending so timeout can reject the request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { collector, sends, thread } = createThread();
    const handler = createHandler({}, thread);
    const client = createClient();
    vi.mocked(client.permission.reply).mockResolvedValueOnce({ error: { message: 'failed' } });

    await handler.handlePermissionEvent(
      'thread-1',
      { id: 'request-1', sessionID: 'session-1', permission: 'bash', patterns: ['pnpm test'] },
      client,
    );
    const failedInteraction = await collector.emitCollect('allow_once');
    expect(failedInteraction.update).toHaveBeenCalledWith({ content: '권한 응답에 실패했습니다. 다시 시도하세요.', components: permissionButtons });

    await collector.emitEnd('time');

    expect(client.permission.reply).toHaveBeenCalledTimes(2);
    expect(client.permission.reply).toHaveBeenNthCalledWith(2, { requestID: 'request-1', reply: 'reject' });
    expect(sends.at(-1)?.content).toBe('권한 요청 시간이 만료되어 거부했습니다.');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
