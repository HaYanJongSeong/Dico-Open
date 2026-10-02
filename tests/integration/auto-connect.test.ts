import { describe, expect, it, vi } from 'vitest';
import { startBot } from '../../src/index.js';
import { StreamHandler } from '../../src/opencode/streamHandler.js';
import type { AutoConnectDelegate, GlobalEventLike, OpenCodeStreamClient, StreamMessage, StreamThread } from '../../src/opencode/streamHandler.js';
import type { BotState, SessionState } from '../../src/state/types.js';

function stream(events: GlobalEventLike[]): AsyncIterable<GlobalEventLike> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function failingStream(): AsyncIterable<GlobalEventLike> {
  return {
    async *[Symbol.asyncIterator]() {
      throw new Error('sse disconnected');
    },
  };
}

function createThread(): { thread: StreamThread; message: StreamMessage; sends: string[] } {
  const sends: string[] = [];
  const message = { edit: vi.fn(async () => undefined) };
  return {
    message,
    sends,
    thread: {
      send: vi.fn(async (content: string) => {
        sends.push(content);
        return message;
      }),
    },
  };
}

function createStateManager(state: BotState) {
  return {
    load: vi.fn(),
    getState: vi.fn(() => state),
    getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
    setServer: vi.fn(),
    removeServer: vi.fn(),
    getSession: vi.fn((threadId: string) => state.sessions[threadId]),
    setSession: vi.fn((threadId: string, session: SessionState) => {
      state.sessions[threadId] = session;
    }),
    removeSession: vi.fn(),
    getQueue: vi.fn(() => []),
    clearQueue: vi.fn(),
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });

  return { promise, resolve };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('auto-connect integration', () => {
  it('handles session.created by creating a Discord thread, persisting the mapping, subscribing, and notifying the thread', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const thread = { id: 'thread-auto', send: vi.fn(async () => ({ edit: vi.fn() })) };
    const parentChannel = { threads: { create: vi.fn(async () => thread) } };
    const client = {
      session: { list: vi.fn(async () => []) },
      global: { event: vi.fn(() => stream([{ directory: '/workspace/project', payload: { type: 'session.created', info: { id: 'session-event', title: 'Event session' } } }])) },
    };
    const stateManager = createStateManager(state);
    const streamHandler = { subscribe: vi.fn() };
    const discordClient = {
      login: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      channels: { fetch: vi.fn(async () => parentChannel) },
    };

    await startBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => ({ discordToken: 'token', servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/workspace/project', autoConnect: true }] }] })) },
      stateManager,
      serverManager: { ensureRunning: vi.fn(async () => client), getClient: vi.fn(), shutdownAll: vi.fn() },
      cacheManager: { refresh: vi.fn() },
      streamHandler,
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      now: vi.fn(() => 1234),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(parentChannel.threads.create).toHaveBeenCalledWith({ name: 'Event session' });
    expect(state.sessions['thread-auto']).toEqual({
      sessionId: 'session-event',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/workspace/project',
      agent: 'build',
      model: null,
      createdBy: 'auto-connect',
      createdAt: 1234,
      lastActivityAt: 1234,
      userMirrorSince: 1234,
      status: 'active',
    });
    expect(thread.send).toHaveBeenCalledWith('세션 `session-event`에 자동으로 연결했습니다.');
    expect(streamHandler.subscribe).toHaveBeenCalledWith('thread-auto', 'session-event', client, expect.any(Set), '/workspace/project');
  });

  it('recovers missed auto-connect sessions after stream reconnect and continues active streaming', async () => {
    const { thread, sends } = createThread();
    const autoConnectHandler: AutoConnectDelegate = {
      isSessionAttached: vi.fn(() => false),
      handleSessionCreated: vi.fn(async () => undefined),
      recoverMissedSessions: vi.fn(async () => undefined),
    };
    const handler = new StreamHandler({
      getThread: () => thread,
      questionHandler: { handleQuestionEvent: vi.fn() },
      permissionHandler: { handlePermissionEvent: vi.fn() },
      autoConnectHandler,
      retryDelayMs: 0,
      editThrottleMs: 0,
      maxRetries: 1,
    });
    const client: OpenCodeStreamClient = {
      global: {
        event: vi
          .fn()
          .mockResolvedValueOnce(failingStream())
          .mockResolvedValueOnce(stream([{ directory: '/workspace/project', payload: { type: 'message.part.delta', sessionID: 'session-active', partID: 'part-1', field: 'text', delta: 'after reconnect', part: { id: 'part-1', type: 'text' } } }])),
      },
    };

    await handler.subscribe('thread-active', 'session-active', client, undefined, '/workspace/project');
    await handler.waitForIdle('thread-active');

    expect(autoConnectHandler.recoverMissedSessions).toHaveBeenCalledWith('/workspace/project', client);
    expect(sends).toEqual(['after reconnect']);
  });

  it('does not auto-connect duplicate session.created events for already attached sessions', async () => {
    const { thread } = createThread();
    const autoConnectHandler: AutoConnectDelegate = {
      isSessionAttached: vi.fn((sessionId: string) => sessionId === 'session-attached'),
      handleSessionCreated: vi.fn(async () => undefined),
      recoverMissedSessions: vi.fn(async () => undefined),
    };
    const handler = new StreamHandler({
      getThread: () => thread,
      questionHandler: { handleQuestionEvent: vi.fn() },
      permissionHandler: { handlePermissionEvent: vi.fn() },
      autoConnectHandler,
      editThrottleMs: 0,
    });
    const client: OpenCodeStreamClient = {
      global: {
        event: vi.fn(() => stream([
          { directory: '/workspace/project', payload: { type: 'session.created', info: { id: 'session-attached' } } },
          { directory: '/workspace/project', payload: { type: 'session.created', info: { id: 'session-new' } } },
        ])),
      },
    };

    await handler.subscribe('thread-active', 'session-active', client, undefined, '/workspace/project');
    await handler.waitForIdle('thread-active');

    expect(autoConnectHandler.handleSessionCreated).toHaveBeenCalledTimes(1);
    expect(autoConnectHandler.handleSessionCreated).toHaveBeenCalledWith('/workspace/project', { id: 'session-new' }, client);
  });

  it('deduplicates startup session.created events against session list reconciliation before thread creation completes', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = createStateManager(state);
    const duplicateSession = { id: 'session-1', title: 'Same session' };
    const releaseEvents = deferred<void>();
    const releaseThreadCreate = deferred<void>();
    async function* events(): AsyncIterable<GlobalEventLike> {
      await releaseEvents.promise;
      yield { directory: '/workspace/project', payload: { type: 'session.created', info: duplicateSession } };
    }
    const client = {
      session: {
        list: vi.fn(async () => {
          releaseEvents.resolve();
          await flushAsync();
          return [duplicateSession];
        }),
      },
      global: { event: vi.fn(() => events()) },
    };
    const createdThreads: Array<{ id: string; send: ReturnType<typeof vi.fn> }> = [];
    const parentChannel = {
      threads: {
        create: vi.fn(async () => {
          await releaseThreadCreate.promise;
          const thread = { id: `thread-${createdThreads.length + 1}`, send: vi.fn(async () => ({ edit: vi.fn() })) };
          createdThreads.push(thread);
          return thread;
        }),
      },
    };
    const streamHandler = { subscribe: vi.fn() };

    const started = startBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => ({ discordToken: 'token', servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/workspace/project', autoConnect: true }] }] })) },
      stateManager,
      serverManager: { ensureRunning: vi.fn(async () => client), getClient: vi.fn(), shutdownAll: vi.fn() },
      cacheManager: { refresh: vi.fn() },
      streamHandler,
      createDiscordClient: vi.fn(() => ({ login: vi.fn(), destroy: vi.fn(), on: vi.fn(), off: vi.fn(), channels: { fetch: vi.fn(async () => parentChannel) } })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });
    await flushAsync();
    await flushAsync();
    releaseThreadCreate.resolve();
    await started;
    await flushAsync();

    const persistedSessionIds = Object.values(state.sessions).map((session) => session.sessionId).sort();
    expect(parentChannel.threads.create).toHaveBeenCalledTimes(1);
    expect(persistedSessionIds).toEqual(['session-1']);
    expect(streamHandler.subscribe).toHaveBeenCalledTimes(1);
  });

  it('auto-connects session.created events observed by the default recovered session stream handler', async () => {
    const existingSession: SessionState = {
      sessionId: 'session-active',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/workspace/project',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 10,
      lastActivityAt: 20,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/workspace/project': { port: 3333, pid: 4444, url: 'http://127.0.0.1:3333', startedAt: 1, status: 'running' } },
      sessions: { 'thread-active': existingSession },
      queues: {},
    };
    const stateManager = createStateManager(state);
    const activeThread = { id: 'thread-active', send: vi.fn(async () => ({ edit: vi.fn() })) };
    const autoThread = { id: 'thread-auto', send: vi.fn(async () => ({ edit: vi.fn() })) };
    const parentChannel = { threads: { create: vi.fn(async () => autoThread) } };
    const client = {
      session: { list: vi.fn(async () => []) },
      global: {
        event: vi
          .fn()
          .mockResolvedValueOnce(stream([{ directory: '/workspace/project', payload: { type: 'session.created', info: { id: 'session-new', title: 'New default stream session' } } }]))
          .mockResolvedValueOnce(stream([])),
      },
    };
    const discordClient = {
      login: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      channels: {
        fetch: vi.fn(async (channelId: string) => {
          if (channelId === 'thread-active') {
            return activeThread;
          }

          return parentChannel;
        }),
      },
    };

    await startBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => ({ discordToken: 'token', servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/workspace/project', autoConnect: true }] }] })) },
      stateManager,
      serverManager: { ensureRunning: vi.fn(async () => client), getClient: vi.fn(() => client), shutdownAll: vi.fn() },
      cacheManager: { refresh: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      healthCheck: vi.fn(() => true),
      createClient: vi.fn(() => client),
      now: vi.fn(() => 1234),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });
    await flushAsync();

    expect(parentChannel.threads.create).toHaveBeenCalledWith({ name: 'New default stream session' });
    expect(state.sessions['thread-auto']).toEqual({
      sessionId: 'session-new',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/workspace/project',
      agent: 'build',
      model: null,
      createdBy: 'auto-connect',
      createdAt: 1234,
      lastActivityAt: 1234,
      userMirrorSince: 1234,
      status: 'active',
    });
    expect(autoThread.send).toHaveBeenCalledWith('세션 `session-new`에 자동으로 연결했습니다.');
  });

  it('keeps retrying project events after an SSE disconnect and reconciles missed sessions', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = createStateManager(state);
    const missedSession = { id: 'session-after-disconnect', title: 'Recovered after disconnect' };
    const client = {
      session: {
        list: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([missedSession]),
      },
      global: {
        event: vi
          .fn()
          .mockResolvedValueOnce(failingStream())
          .mockResolvedValueOnce(stream([])),
      },
    };
    const thread = { id: 'thread-recovered', send: vi.fn(async () => ({ edit: vi.fn() })) };
    const parentChannel = { threads: { create: vi.fn(async () => thread) } };
    const streamHandler = { subscribe: vi.fn() };

    await startBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => ({ discordToken: 'token', servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/workspace/project', autoConnect: true }] }] })) },
      stateManager,
      serverManager: { ensureRunning: vi.fn(async () => client), getClient: vi.fn(), shutdownAll: vi.fn() },
      cacheManager: { refresh: vi.fn() },
      streamHandler,
      createDiscordClient: vi.fn(() => ({ login: vi.fn(), destroy: vi.fn(), on: vi.fn(), off: vi.fn(), channels: { fetch: vi.fn(async () => parentChannel) } })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });
    await flushAsync();
    await flushAsync();

    expect(client.global.event).toHaveBeenCalledTimes(2);
    expect(client.session.list).toHaveBeenCalledTimes(3);
    expect(parentChannel.threads.create).toHaveBeenCalledTimes(1);
    expect(state.sessions['thread-recovered']).toMatchObject({ sessionId: 'session-after-disconnect' });
  });
});
