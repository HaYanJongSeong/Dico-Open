import { describe, expect, it, vi } from 'vitest';
import { startBot } from '../../src/index.js';
import { ErrorCode } from '../../src/utils/errors.js';
import type { BotState, ServerState, SessionState } from '../../src/state/types.js';

function createStateManager(state: BotState) {
  return {
    load: vi.fn(),
    getState: vi.fn(() => state),
    getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
    setServer: vi.fn((projectPath: string, server: ServerState) => {
      state.servers[projectPath] = server;
    }),
    removeServer: vi.fn((projectPath: string) => {
      delete state.servers[projectPath];
    }),
    getSession: vi.fn((threadId: string) => state.sessions[threadId]),
    setSession: vi.fn((threadId: string, session: SessionState) => {
      state.sessions[threadId] = session;
    }),
    removeSession: vi.fn((threadId: string) => {
      delete state.sessions[threadId];
    }),
    getQueue: vi.fn((threadId: string) => state.queues[threadId] ?? []),
    clearQueue: vi.fn((threadId: string) => {
      state.queues[threadId] = [];
    }),
  };
}

function createConfig(projectPath = '/workspace/project') {
  return {
    discordToken: 'discord-token',
    servers: [
      {
        serverId: 'guild-1',
        channels: [{ channelId: 'channel-1', projectPath, autoConnect: true, defaultAgent: 'build' }],
      },
    ],
  };
}

describe('startup integration', () => {
  it('loads config, starts an auto-connect server, creates a session thread, streams content, and shuts down cleanly', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = createStateManager(state);
    const streamMessage = { edit: vi.fn(async () => undefined) };
    const autoThread = {
      id: 'thread-auto',
      send: vi.fn(async () => streamMessage),
    };
    const parentChannel = {
      threads: {
        create: vi.fn(async () => autoThread),
      },
    };
    async function* events() {
      yield { directory: '/workspace/project', payload: { type: 'message.part.delta', sessionID: 'session-created', partID: 'part-1', field: 'text', delta: 'hello' } };
      yield { directory: '/workspace/project', payload: { type: 'message.part.delta', sessionID: 'session-created', partID: 'part-1', field: 'text', delta: ' world' } };
    }
    const client = {
      global: { event: vi.fn(() => events()) },
      session: { list: vi.fn(async () => [{ id: 'session-created', title: 'Started outside Discord' }]) },
    };
    const streamHandlerSubscriptions: Array<{ waitForIdle(threadId: string): Promise<void> }> = [];
    const discordClient = {
      login: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      channels: { fetch: vi.fn(async () => parentChannel) },
    };
    const serverManager = {
      ensureRunning: vi.fn(async () => client),
      getClient: vi.fn(() => client),
      shutdownAll: vi.fn(),
    };

    const started = await startBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => createConfig()) },
      stateManager,
      serverManager,
      cacheManager: { refresh: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      createStreamHandler: ({ getThread }) => {
        const handler = new (class {
          private readonly delegate = new Map<string, Promise<void>>();

          public async subscribe(threadId: string, sessionId: string): Promise<void> {
            const thread = getThread(threadId);
            if (!thread) {
              return;
            }
            const promise = (async () => {
              const message = await thread.send('hello');
              await message.edit('hello world');
              await thread.send(`Auto-connected to session \`${sessionId}\`.`);
            })();
            this.delegate.set(threadId, promise);
            await promise;
          }

          public async waitForIdle(threadId: string): Promise<void> {
            await this.delegate.get(threadId);
          }
        })();
        streamHandlerSubscriptions.push(handler);
        return handler;
      },
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      now: vi.fn(() => 1000),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });

    await streamHandlerSubscriptions[0]?.waitForIdle('thread-auto');
    await started.lifecycleController.shutdown();

    expect(discordClient.login).toHaveBeenCalledWith('discord-token');
    expect(serverManager.ensureRunning).toHaveBeenCalledWith('/workspace/project');
    expect(parentChannel.threads.create).toHaveBeenCalledWith({ name: 'Started outside Discord' });
    expect(state.sessions['thread-auto']).toMatchObject({
      sessionId: 'session-created',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/workspace/project',
      status: 'active',
    });
    expect(autoThread.send).toHaveBeenCalledWith('hello');
    expect(streamMessage.edit).toHaveBeenCalledWith('hello world');
    expect(serverManager.shutdownAll).toHaveBeenCalledOnce();
    expect(discordClient.destroy).toHaveBeenCalledOnce();
  });

  it('marks a dead recovered server stopped, respawns it for auto-connect, and subscribes project events', async () => {
    const server: ServerState = { port: 3000, pid: 1234, url: 'http://127.0.0.1:3000', startedAt: 1, status: 'running' };
    const state: BotState = { version: 1, servers: { '/workspace/project': server }, sessions: {}, queues: {} };
    const stateManager = createStateManager(state);
    const restartedClient = { session: { list: vi.fn(async () => []) } };
    const subscribeProjectEvents = vi.fn();

    await startBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => createConfig()) },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(async () => restartedClient),
        getClient: vi.fn(() => undefined),
        shutdownAll: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn(), destroy: vi.fn(), on: vi.fn(), off: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => false),
      subscribeProjectEvents,
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });

    expect(stateManager.setServer).toHaveBeenCalledWith('/workspace/project', { ...server, status: 'stopped' });
    expect(subscribeProjectEvents).toHaveBeenCalledWith('/workspace/project', restartedClient);
  });

  it('kills an unhealthy recovered server, respawns it for auto-connect, and reconnects active sessions to the new client', async () => {
    const server: ServerState = { port: 3000, pid: 1234, url: 'http://127.0.0.1:3000', startedAt: 1, status: 'running' };
    const session: SessionState = {
      sessionId: 'session-existing',
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
      servers: { '/workspace/project': server },
      sessions: { 'thread-existing': session },
      queues: {},
    };
    const stateManager = createStateManager(state);
    const unhealthyClient = { id: 'unhealthy-client' };
    const restartedClient = { session: { list: vi.fn(async () => []) } };
    const streamHandler = { subscribe: vi.fn() };
    const killPid = vi.fn();
    const ensureRunning = vi.fn(async () => {
      stateManager.setServer('/workspace/project', { ...server, pid: 5678, url: 'http://127.0.0.1:4000', status: 'running' });
      return restartedClient;
    });

    await startBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => createConfig()) },
      stateManager,
      serverManager: {
        ensureRunning,
        getClient: vi.fn(() => undefined),
        shutdownAll: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler,
      createDiscordClient: vi.fn(() => ({ login: vi.fn(), destroy: vi.fn(), on: vi.fn(), off: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => unhealthyClient),
      healthCheck: vi.fn(() => false),
      killPid,
      threadExists: vi.fn(() => true),
      notifyThread: vi.fn(),
      subscribeProjectEvents: vi.fn(),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });

    expect(killPid).toHaveBeenCalledWith(1234);
    expect(stateManager.setServer).toHaveBeenCalledWith('/workspace/project', { ...server, status: 'stopped' });
    expect(ensureRunning).toHaveBeenCalledWith('/workspace/project');
    await vi.waitFor(() => {
      expect(streamHandler.subscribe).toHaveBeenCalledWith('thread-existing', 'session-existing', restartedClient, expect.any(Set), '/workspace/project');
    });
  });

  it('reports startup error paths for invalid config and missing OpenCode CLI', async () => {
    const stateManager = createStateManager({ version: 1, servers: {}, sessions: {}, queues: {} });

    await expect(startBot({
      configLoader: { load: vi.fn(async () => { throw Object.assign(new Error('invalid config'), { code: ErrorCode.CONFIG_INVALID }); }), getConfig: vi.fn(() => createConfig()) },
      stateManager,
      preflight: vi.fn(),
    })).rejects.toMatchObject({ code: ErrorCode.CONFIG_INVALID });

    await expect(startBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => createConfig()) },
      stateManager,
      preflight: vi.fn(async () => { throw Object.assign(new Error('OpenCode CLI was not found'), { code: ErrorCode.SERVER_START_FAILED }); }),
    })).rejects.toMatchObject({ code: ErrorCode.SERVER_START_FAILED });
  });
});
