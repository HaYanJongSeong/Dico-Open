import { pathToFileURL } from 'node:url';
import { MessageFlags } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdaptiveSyncDelay, isDirectEntrypoint, isDiscordSyncStalled, runCli, startBot as realStartBot } from './index.js';
import type { StartedBot, StartBotOptions } from './index.js';
import type { BotState, ServerState, SessionState } from './state/types.js';
import type { SessionBridge } from './opencode/sessionBridge.js';
import { BotError, ErrorCode } from './utils/errors.js';

const startedBots: StartedBot[] = [];

describe('자동 스레드 보관 동기화 회귀', () => {
  afterEach(() => vi.useRealTimers());

  async function setup(status: SessionState['status'] = 'ended', hasClient = true) {
    vi.useFakeTimers();
    const session: SessionState = {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/project',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1, lastActivityAt: 1,
      lastSyncedMessageId: 'already-synced', status,
    };
    const state: BotState = { version: 1, sessions: { 'thread-1': session }, servers: {}, queues: {} };
    const stateManager = {
      load: vi.fn(), getState: () => state, getServer: vi.fn(() => ({ status: 'running' } as ServerState)),
      setServer: vi.fn(), removeServer: vi.fn(), getSession: (id: string) => state.sessions[id],
      setSession: vi.fn((id: string, next: SessionState) => { state.sessions[id] = next; }),
      removeSession: vi.fn((id: string) => { delete state.sessions[id]; }),
      getQueue: () => [], clearQueue: vi.fn(),
    };
    const thread = {
      id: 'thread-1', ownerId: 'bot-1', guildId: 'guild-1', parentId: 'channel-1', archived: false,
      isThread: () => true, send: vi.fn(),
      setArchived: vi.fn(async () => { thread.archived = true; }),
    };
    const create = vi.fn(async () => ({ ...thread, id: 'new-thread' }));
    const fetch = vi.fn(async (id: string): Promise<unknown> => id === 'channel-1' ? { threads: { create } } : thread);
    const client = { session: { list: vi.fn(async () => [{ id: 'session-1', title: 'Same title', directory: '/project' }]) } };
    const replaySessionHistory = vi.fn(async () => ({ latestAssistantAt: undefined }));
    const runtimeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const on = vi.fn();
    const unsubscribe = vi.fn();
    await startBot({
      configLoader: { load: vi.fn(), getConfig: () => ({ discordToken: 'token', servers: [{
        serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project', autoConnect: true }],
      }] }) },
      stateManager, serverManager: {
        getClient: () => hasClient ? client : undefined, ensureRunning: vi.fn(async () => hasClient ? client : undefined),
      },
      cacheManager: { refresh: vi.fn() }, streamHandler: { subscribe: vi.fn(), unsubscribe },
      sessionBridge: { getDedupeSet: () => new Set<string>(), replaySessionHistory } as unknown as SessionBridge,
      createDiscordClient: () => ({ login: vi.fn(), user: { id: 'bot-1' }, channels: { fetch }, on }),
      threadExists: () => true, deployCommands: vi.fn(), getCommandDefinitions: () => [], preflight: vi.fn(),
      logger: runtimeLogger,
    });
    const tick = async () => { await vi.advanceTimersByTimeAsync(1000); };
    return { session, state, stateManager, thread, create, fetch, replaySessionHistory, runtimeLogger, tick, on, unsubscribe };
  }

  it('ended 제목이 존재해도 새 스레드를 만들지 않고 서버 없이 기존 대화를 보관한다', async () => {
    const f = await setup('ended', false);
    await f.tick();
    expect(f.thread.setArchived).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.state.sessions['thread-1']).toBe(f.session);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.stateManager.removeSession).not.toHaveBeenCalled();
  });

  it('ended 제목이 최신 세션 목록에 있어도 자동 재연결하지 않는다', async () => {
    const f = await setup();
    await f.tick();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.stateManager.removeSession).not.toHaveBeenCalled();
    expect(f.thread.setArchived).toHaveBeenCalledOnce();
  });

  it.each(['active', 'inactive'] as const)('정상 %s 세션은 사용자 소유여도 동기화를 유지한다', async (status) => {
    const f = await setup(status);
    f.thread.ownerId = 'user-1';
    await f.tick();
    expect(f.replaySessionHistory).toHaveBeenCalledOnce();
    expect(f.thread.setArchived).not.toHaveBeenCalled();
    expect(f.state.sessions['thread-1']?.status).toBe(status);
  });

  it('사용자 소유 ended 스레드는 보관하지 않는다', async () => {
    const f = await setup();
    f.thread.ownerId = 'user-1';
    await f.tick();
    expect(f.thread.setArchived).not.toHaveBeenCalled();
  });

  it.each(['active', 'inactive'] as const)('서버 없는 %s 세션은 조회·상태변경을 건너뛴다', async (status) => {
    const f = await setup(status, false);
    f.fetch.mockClear();
    await f.tick();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.stateManager.setSession).not.toHaveBeenCalled();
  });

  it.each([{ code: 50013, status: 403 }, new Error('network'), { code: 10008, status: 404 }, { status: 404, message: 'other resource' }])(
    '일시 조회 실패 또는 채널이 아닌 404는 연결 상태를 유지한다: %j', async (error) => {
      const f = await setup('active');
      f.fetch.mockRejectedValue(error);
      await f.tick();
      expect(f.stateManager.setSession).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.runtimeLogger.warn).toHaveBeenCalledWith('Failed to synchronize session', expect.objectContaining({ error }));
    },
  );

  it('캐시의 archived 값을 신뢰하지 않고 실제 조회 후 중복 보관을 제외한다', async () => {
    const f = await setup();
    const messageListener = f.on.mock.calls.find(([name]) => name === 'messageCreate')?.[1] as (message: unknown) => void;
    messageListener({ channel: f.thread, author: { id: 'bot-1', bot: true }, content: '', attachments: new Map() });
    f.fetch.mockResolvedValue({ ...f.thread, archived: true });
    await f.tick();
    expect(f.fetch).toHaveBeenCalledWith('thread-1', { force: true });
    expect(f.thread.setArchived).not.toHaveBeenCalled();
  });

  it('보관 실패 시 다음 기존 동기화에서 재시도한다', async () => {
    const f = await setup();
    f.thread.setArchived.mockRejectedValueOnce(new Error('403'));
    await f.tick();
    expect(f.state.sessions['thread-1']).toBe(f.session);
    await f.tick();
    expect(f.thread.setArchived).toHaveBeenCalledTimes(2);
    expect(f.runtimeLogger.warn).toHaveBeenCalledWith(expect.stringContaining('재시도'), expect.any(Object));
    await f.tick();
    expect(f.thread.setArchived).toHaveBeenCalledTimes(2);
  });

  it('실제 조회 도중 /connect가 변경한 sessionId/status를 다시 확인한다', async () => {
    const f = await setup();
    f.fetch.mockImplementationOnce(async () => {
      f.state.sessions['thread-1'] = { ...f.session, sessionId: 'new-session', status: 'active' };
      return f.thread;
    });
    await f.tick();
    expect(f.thread.setArchived).not.toHaveBeenCalled();
  });

  it('SDK 명시적 404 안내 후 즉시 보관한다', async () => {
    const f = await setup('active');
    f.replaySessionHistory.mockRejectedValueOnce(new BotError(ErrorCode.SESSION_NOT_FOUND, 'not found', { status: 404 }));
    await f.tick();
    expect(f.state.sessions['thread-1']?.status).toBe('ended');
    expect(f.thread.send).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledWith('thread-1');
    expect(f.thread.setArchived).toHaveBeenCalledOnce();
    expect(f.thread.send.mock.invocationCallOrder[0]).toBeLessThan(f.thread.setArchived.mock.invocationCallOrder[0]!);
  });
});

describe('적응형 동기화 간격', () => {
  it('활동 직후 빠르게 조회하고 유휴 상태에서는 최대 15초까지 늦춘다', () => {
    const activity = 1_000_000;
    expect([0, 9_999, 10_000, 29_999, 30_000, 59_999, 60_000, 119_999, 120_000, 600_000]
      .map((elapsed) => getAdaptiveSyncDelay(activity, activity + elapsed)))
      .toEqual([1, 1, 2, 2, 5, 5, 10, 10, 15, 15]);
    expect(getAdaptiveSyncDelay(activity, activity - 1)).toBe(1);
    expect(getAdaptiveSyncDelay(activity + 600_000, activity + 600_000)).toBe(1);
  });
});

async function startBot(options: StartBotOptions = {}): Promise<StartedBot> {
  const started = await realStartBot(options);
  startedBots.push(started);
  return started;
}

afterEach(async () => {
  const bots = startedBots.splice(0);
  await Promise.all(bots.map(async (bot) => {
    await bot.lifecycleController.dispose();
  }));
  vi.unstubAllEnvs();
});

describe('CLI entrypoint', () => {
  it('detects when index.ts is executed directly', () => {
    const moduleUrl = pathToFileURL('/repo/src/index.ts').href;

    expect(isDirectEntrypoint(moduleUrl, ['/node', '/repo/src/index.ts'])).toBe(true);
    expect(isDirectEntrypoint(moduleUrl, ['/node', '/repo/src/index.test.ts'])).toBe(false);
  });

  it('starts the bot through the CLI runner', async () => {
    const start = vi.fn(async () => undefined);
    const logger = { error: vi.fn() };
    const processLike = { exitCode: 0 };

    await runCli({ start, logger, processLike });

    expect(start).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
    expect(processLike.exitCode).toBe(0);
  });

  it('logs startup failures and exits non-zero', async () => {
    const error = new BotError(ErrorCode.CONFIG_INVALID, 'Cannot read config file: config.yaml', { path: 'config.yaml' });
    const start = vi.fn(async () => {
      throw error;
    });
    const logger = { error: vi.fn() };
    const processLike = { exitCode: 0 };

    await runCli({ start, logger, processLike });

    expect(logger.error).toHaveBeenCalledWith('Bot startup failed', {
      code: ErrorCode.CONFIG_INVALID,
      error: 'Cannot read config file: config.yaml',
      path: 'config.yaml',
    });
    expect(processLike.exitCode).toBe(1);
  });

  it('keeps the BotError message when context includes an error field', async () => {
    const error = new BotError(ErrorCode.SERVER_START_FAILED, 'OpenCode CLI was not found in PATH', { error: 'spawn opencode ENOENT' });
    const start = vi.fn(async () => {
      throw error;
    });
    const logger = { error: vi.fn() };
    const processLike = { exitCode: 0 };

    await runCli({ start, logger, processLike });

    expect(logger.error).toHaveBeenCalledWith('Bot startup failed', {
      code: ErrorCode.SERVER_START_FAILED,
      error: 'OpenCode CLI was not found in PATH',
    });
    expect(processLike.exitCode).toBe(1);
  });
});

describe('Discord sync monitoring', () => {
  it('detects recent assistant output with no newer Discord bot delivery', async () => {
    const messages = new Map([['1', { author: { id: 'bot-1' }, createdTimestamp: 1000, editedTimestamp: null, content: '이전 응답' }]]);
    const thread = { messages: { fetch: vi.fn(async () => messages) } };
    expect(await isDiscordSyncStalled(thread, 'bot-1', 5000, 125001)).toBe(true);
    expect(thread.messages.fetch).toHaveBeenCalledWith({ limit: 25 });
    expect(await isDiscordSyncStalled(thread, 'bot-1', 5000, 5001)).toBe(false);
    messages.set('1', { author: { id: 'bot-1' }, createdTimestamp: 6000, editedTimestamp: null, content: '최신 응답' });
    expect(await isDiscordSyncStalled(thread, 'bot-1', 5000, 125001)).toBe(false);
    messages.set('1', { author: { id: 'bot-1' }, createdTimestamp: 1000, editedTimestamp: null, content: '이전 응답' });
    messages.set('2', { author: { id: 'bot-1' }, createdTimestamp: 6000, editedTimestamp: null, content: '최신 응답' });
    expect(await isDiscordSyncStalled(thread, 'bot-1', 5000, 125001)).toBe(false);
    messages.set('2', { author: { id: 'bot-1' }, createdTimestamp: 6000, editedTimestamp: null, content: '**User:**\n> 새 질문' });
    expect(await isDiscordSyncStalled(thread, 'bot-1', 5000, 125001)).toBe(true);
    messages.set('2', { author: { id: 'bot-1' }, createdTimestamp: 6000, editedTimestamp: null, content: '**나:**\n> 새 질문' });
    expect(await isDiscordSyncStalled(thread, 'bot-1', 5000, 125001)).toBe(true);
  });
});

describe('startBot', () => {
  it('treats a failed Discord login as a fatal startup error', async () => {
    const serverManager = { ensureRunning: vi.fn(), getClient: vi.fn(), shutdownAll: vi.fn() };
    await expect(realStartBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => ({ discordToken: 'token', servers: [] })) },
      stateManager: {
        load: vi.fn(), getState: vi.fn(() => ({ version: 1, servers: {}, sessions: {}, queues: {} })),
        getServer: vi.fn(), setServer: vi.fn(), removeServer: vi.fn(),
        getSession: vi.fn(), setSession: vi.fn(), removeSession: vi.fn(),
        getQueue: vi.fn(() => []), clearQueue: vi.fn(),
      },
      serverManager, cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn(async () => { throw new Error('login failed'); }) })),
      deployCommands: vi.fn(), getCommandDefinitions: vi.fn(() => []), preflight: vi.fn(),
    })).rejects.toThrow('login failed');
    expect(serverManager.shutdownAll).toHaveBeenCalledOnce();
  });

  it('logs startup milestones around Discord login', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await startBot({
      logger,
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({ discordToken: 'token', servers: [] })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => ({ version: 1, servers: {}, sessions: {}, queues: {} })),
        getServer: vi.fn(),
        setServer: vi.fn(),
        removeServer: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
      },
      serverManager: { ensureRunning: vi.fn(), getClient: vi.fn(), shutdownAll: vi.fn() },
      cacheManager: { refresh: vi.fn(), getSessions: vi.fn(() => []) },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      registerLifecycleHandlers: vi.fn(() => ({ runInactivityCheck: vi.fn(), shutdown: vi.fn(), dispose: vi.fn() })),
    });

    expect(logger.info).toHaveBeenCalledWith('Discord 로그인 시작');
    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith('Discord 로그인 완료');
    });
  });

  it('watches config reloads, cleans up removed channel sessions, redeploys commands, and closes the watcher', async () => {
    let reloadConfig = {
      discordToken: 'token',
      servers: [{ serverId: 'guild-2', channels: [{ channelId: 'channel-new', projectPath: '/project/new' }] }],
    };
    const removedSession: SessionState = {
      sessionId: 'session-removed',
      guildId: 'guild-1',
      channelId: 'channel-removed',
      projectPath: '/project/removed',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 10,
      lastActivityAt: 20,
      status: 'active',
    };
    const otherSession: SessionState = {
      ...removedSession,
      sessionId: 'session-kept',
      channelId: 'channel-kept',
    };
    const endedSession: SessionState = {
      ...removedSession,
      sessionId: 'session-ended',
      status: 'ended',
    };
    const state: BotState = {
      version: 1,
      servers: {},
      sessions: {
        'thread-removed': removedSession,
        'thread-kept': otherSession,
        'thread-ended': endedSession,
      },
      queues: {
        'thread-removed': [{ userId: 'user-1', content: 'remove me', attachments: [], queuedAt: 30 }],
        'thread-kept': [{ userId: 'user-2', content: 'keep me', attachments: [], queuedAt: 40 }],
      },
    };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, session: SessionState) => {
        state.sessions[threadId] = session;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn((threadId: string) => state.queues[threadId] ?? []),
      clearQueue: vi.fn((threadId: string) => {
        state.queues[threadId] = [];
      }),
    };
    const opencodeClient = { session: { abort: vi.fn() } };
    const thread = { send: vi.fn(), setArchived: vi.fn() };
    const lifecycleController = {
      runInactivityCheck: vi.fn(),
      shutdown: vi.fn(),
      dispose: vi.fn(),
    };
    const registerLifecycleHandlers = vi.fn<typeof startBot extends (options: infer Options) => Promise<unknown>
      ? NonNullable<Options extends { registerLifecycleHandlers?: infer Register } ? Register : never>
      : never>(() => lifecycleController);
    const watch = vi.fn();
    const close = vi.fn();
    const onChange = vi.fn((callback: (config: typeof reloadConfig) => void) => {
      callback(reloadConfig);
    });
    const deployCommands = vi.fn();

    const started = await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-removed', projectPath: '/project/removed' }] }],
        })),
        watch,
        close,
        onChange,
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => opencodeClient),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({
        login: vi.fn(),
        channels: { fetch: vi.fn(async () => thread) },
      })),
      deployCommands,
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      registerLifecycleHandlers,
    });

    expect(watch).toHaveBeenCalledOnce();
    const watchOptions = watch.mock.calls[0]?.[0] as { onChannelRemoved?: (guildId: string, channelId: string) => Promise<void> | void } | undefined;
    expect(watchOptions?.onChannelRemoved).toBeTypeOf('function');
    await watchOptions?.onChannelRemoved?.('guild-1', 'channel-removed');

    expect(opencodeClient.session.abort).toHaveBeenCalledWith({ sessionID: 'session-removed' });
    expect(stateManager.setSession).toHaveBeenCalledWith('thread-removed', { ...removedSession, status: 'ended' });
    expect(stateManager.clearQueue).toHaveBeenCalledWith('thread-removed');
    expect(thread.send).toHaveBeenCalledWith('설정에서 채널이 제거되어 세션을 종료했습니다.');
    expect(thread.setArchived).toHaveBeenCalledWith(true);
    expect(state.sessions['thread-kept']?.status).toBe('active');
    expect(opencodeClient.session.abort).not.toHaveBeenCalledWith({ sessionID: 'session-ended' });

    expect(onChange).toHaveBeenCalledOnce();
    expect(deployCommands).toHaveBeenCalledWith('token', 'guild-2', []);

    reloadConfig = { discordToken: 'token', servers: [] };
    await started.lifecycleController.shutdown();
    await started.lifecycleController.dispose();

    expect(close).toHaveBeenCalledTimes(2);
    expect(lifecycleController.shutdown).toHaveBeenCalledOnce();
    expect(lifecycleController.dispose).toHaveBeenCalledOnce();
  });

  it('registers lifecycle handlers with startup dependencies and exposes the controller', async () => {
    const session: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/one',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 10,
      lastActivityAt: 20,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: {},
      sessions: { 'thread-1': session },
      queues: {},
    };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, nextSession: SessionState) => {
        state.sessions[threadId] = nextSession;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const opencodeClient = {
      session: {
        abort: vi.fn(),
      },
    };
    const serverManager = {
      ensureRunning: vi.fn(),
      getClient: vi.fn(() => opencodeClient),
      shutdownAll: vi.fn(),
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn() },
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    const lifecycleController = {
      runInactivityCheck: vi.fn(),
      shutdown: vi.fn(),
      dispose: vi.fn(),
    };
    const registerLifecycleHandlers = vi.fn<typeof startBot extends (options: infer Options) => Promise<unknown>
      ? NonNullable<Options extends { registerLifecycleHandlers?: infer Register } ? Register : never>
      : never>(() => lifecycleController);
    const processLike = { on: vi.fn(), off: vi.fn() };
    const setInterval = vi.fn(() => 123);
    const clearInterval = vi.fn();

    const started = await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager,
      serverManager,
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      registerLifecycleHandlers,
      processLike,
      setInterval,
      clearInterval,
    });

    expect(registerLifecycleHandlers).toHaveBeenCalledOnce();
    expect(registerLifecycleHandlers).toHaveBeenCalledWith(discordClient, expect.objectContaining({
      stateManager,
      serverManager,
      processLike,
      setInterval,
      clearInterval,
    }));
    await started.lifecycleController.runInactivityCheck();
    expect(lifecycleController.runInactivityCheck).toHaveBeenCalledOnce();

    const lifecycleOptions = registerLifecycleHandlers.mock.calls[0]?.[1];
    expect(lifecycleOptions).toBeDefined();
    if (lifecycleOptions === undefined) {
      throw new Error('lifecycle options were not captured');
    }
    await lifecycleOptions.abortSession('thread-1', session);

    expect(serverManager.getClient).toHaveBeenCalledWith('/project/one');
    expect(opencodeClient.session.abort).toHaveBeenCalledWith({ sessionID: 'session-1' });
  });

  it('registers Discord interaction and message handlers during startup', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn(),
      setSession: vi.fn(),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn() },
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(),
        shutdownAll: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
    });

    expect(discordClient.on).toHaveBeenCalledWith('interactionCreate', expect.any(Function));
    expect(discordClient.on).toHaveBeenCalledWith('messageCreate', expect.any(Function));
    expect(discordClient.on).toHaveBeenCalledWith('threadDelete', expect.any(Function));

    const interactionListener = discordClient.on.mock.calls.find(([eventName]) => eventName === 'interactionCreate')?.[1] as ((interaction: unknown) => void) | undefined;
    const reply = vi.fn();
    await interactionListener?.({
      id: 'interaction-1',
      channelId: 'channel-1',
      channel: null,
      guildId: 'guild-1',
      commandName: 'help',
      user: { id: 'user-1' },
      replied: false,
      deferred: false,
      isChatInputCommand: () => true,
      isAutocomplete: () => false,
      reply,
      followUp: vi.fn(),
    });

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });

  it('remembers /new threads before subscribing their stream', async () => {
    const calls: string[] = [];
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, session: SessionState) => {
        state.sessions[threadId] = session;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const opencodeClient = {
      session: {
        create: vi.fn(async () => ({ id: 'session-new' })),
        get: vi.fn(async () => ({ id: 'session-new' })),
        abort: vi.fn(),
        messages: vi.fn(),
        promptAsync: vi.fn(async () => undefined),
      },
    };
    const thread = {
      id: 'thread-new',
      send: vi.fn(),
      members: { add: vi.fn(async () => undefined) },
    };
    const parentChannel = {
      threads: {
        create: vi.fn(async () => thread),
      },
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn() },
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    const createStreamHandler = vi.fn((options: { getThread(threadId: string): unknown }) => ({
      subscribe: vi.fn(async (threadId: string) => {
        calls.push(`subscribe:${threadId}:${options.getThread(threadId) === thread ? 'cached' : 'missing'}`);
      }),
    }));

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(async () => opencodeClient),
        getClient: vi.fn(),
        shutdownAll: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      createStreamHandler,
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
    });

    const interactionListener = discordClient.on.mock.calls.find(([eventName]) => eventName === 'interactionCreate')?.[1] as ((interaction: unknown) => Promise<void> | void) | undefined;
    await interactionListener?.({
      id: 'interaction-1',
      channelId: 'channel-1',
      channel: parentChannel,
      guildId: 'guild-1',
      commandName: 'new',
      user: { id: 'user-1' },
      replied: false,
      deferred: false,
      isChatInputCommand: () => true,
      isAutocomplete: () => false,
      options: {
        getString: vi.fn((name: string) => {
          if (name === 'prompt') {
            return 'Build feature';
          }
          return null;
        }),
      },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(),
      followUp: vi.fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(parentChannel.threads.create).toHaveBeenCalledOnce();
    expect(calls).toEqual(['subscribe:thread-new:cached', 'subscribe:thread-new:cached']);
    expect(opencodeClient.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'session-new' }));
  });

  it('refreshes sessions before returning /connect autocomplete choices', async () => {
    const state: BotState = {
      version: 1,
      servers: {},
      sessions: {
        'thread-attached': {
          sessionId: 'session-attached',
          guildId: 'guild-1',
          channelId: 'channel-1',
          projectPath: '/project/one',
          agent: 'build',
          model: null,
          createdBy: 'user-1',
          createdAt: 1,
          lastActivityAt: 1,
          status: 'inactive',
        },
      },
      queues: {},
    };
    const client = {
      session: {
        list: vi.fn(async () => [
          { id: 'session-attached', title: 'Already attached', directory: '/project/one' },
          { id: 'session-new', title: 'Recent session', directory: '/project/one' },
        ]),
      },
    };
    const cacheManager = {
      refresh: vi.fn(async () => undefined),
      getSessions: vi.fn(() => [
        { id: 'session-attached', title: 'Already attached', directory: '/project/one' },
        { id: 'session-new', title: 'Recent session', directory: '/project/one' },
      ]),
      getAgents: vi.fn(() => []),
      getModels: vi.fn(() => []),
      getMcpStatus: vi.fn(() => ({})),
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn() },
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => client),
      },
      cacheManager,
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
    });

    const interactionListener = discordClient.on.mock.calls.find(([eventName]) => eventName === 'interactionCreate')?.[1] as ((interaction: unknown) => Promise<void> | void) | undefined;
    const respond = vi.fn(async () => undefined);
    await interactionListener?.({
      id: 'interaction-1',
      channelId: 'channel-1',
      channel: null,
      guildId: 'guild-1',
      commandName: 'connect',
      options: { getFocused: vi.fn(() => ({ name: 'session', value: '' })) },
      user: { id: 'user-1' },
      isChatInputCommand: () => false,
      isAutocomplete: () => true,
      respond,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(cacheManager.refresh).toHaveBeenCalledWith('/project/one', client);
    expect(respond).toHaveBeenCalledWith([{ name: 'Recent session', value: 'session-new' }]);
  });

  it('returns model autocomplete choices from object-mapped provider metadata', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const cacheManager = {
      refresh: vi.fn(async () => undefined),
      getSessions: vi.fn(() => []),
      getAgents: vi.fn(() => []),
      getModels: vi.fn(() => [{ id: 'github-copilot', models: { 'gpt-5.5': { id: 'gpt-5.5' } } }]),
      getMcpStatus: vi.fn(() => ({})),
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn() },
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(),
      },
      cacheManager,
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
    });

    const interactionListener = discordClient.on.mock.calls.find(([eventName]) => eventName === 'interactionCreate')?.[1] as ((interaction: unknown) => Promise<void> | void) | undefined;
    const respond = vi.fn(async () => undefined);
    await interactionListener?.({
      id: 'interaction-1',
      channelId: 'channel-1',
      channel: null,
      guildId: 'guild-1',
      commandName: 'model',
      options: { getFocused: vi.fn(() => ({ name: 'model', value: 'gpt' })) },
      user: { id: 'user-1' },
      isChatInputCommand: () => false,
      isAutocomplete: () => true,
      respond,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(respond).toHaveBeenCalledWith([{ name: 'github-copilot/gpt-5.5', value: 'github-copilot/gpt-5.5' }]);
  });

  it('returns only direct-use agent autocomplete choices', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const cacheManager = {
      refresh: vi.fn(async () => undefined),
      getSessions: vi.fn(() => []),
      getAgents: vi.fn(() => [
        { name: 'build', mode: 'primary' },
        { name: 'plan', mode: 'primary' },
        { name: 'custom' },
        { name: 'general', mode: 'subagent' },
        { name: 'compact', mode: 'primary', hidden: true },
      ]),
      getModels: vi.fn(() => []),
      getMcpStatus: vi.fn(() => ({})),
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn() },
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(),
      },
      cacheManager,
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
    });

    const interactionListener = discordClient.on.mock.calls.find(([eventName]) => eventName === 'interactionCreate')?.[1] as ((interaction: unknown) => Promise<void> | void) | undefined;
    const respond = vi.fn(async () => undefined);
    await interactionListener?.({
      id: 'interaction-1',
      channelId: 'channel-1',
      channel: null,
      guildId: 'guild-1',
      commandName: 'agent',
      options: { getFocused: vi.fn(() => ({ name: 'agent', value: '' })) },
      user: { id: 'user-1' },
      isChatInputCommand: () => false,
      isAutocomplete: () => true,
      respond,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(respond).toHaveBeenCalledWith([
      { name: 'build', value: 'build' },
      { name: 'plan', value: 'plan' },
      { name: 'custom', value: 'custom' },
    ]);
  });

  it('refreshes agents before returning /agent autocomplete choices when a project server is running', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const client = { app: { agents: vi.fn() } };
    const cacheManager = {
      refresh: vi.fn(async () => undefined),
      getSessions: vi.fn(() => []),
      getAgents: vi.fn(() => [{ name: 'manager', mode: 'primary' }]),
      getModels: vi.fn(() => []),
      getMcpStatus: vi.fn(() => ({})),
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn() },
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => client),
      },
      cacheManager,
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
    });

    const interactionListener = discordClient.on.mock.calls.find(([eventName]) => eventName === 'interactionCreate')?.[1] as ((interaction: unknown) => Promise<void> | void) | undefined;
    const respond = vi.fn(async () => undefined);
    await interactionListener?.({
      id: 'interaction-1',
      channelId: 'channel-1',
      channel: null,
      guildId: 'guild-1',
      commandName: 'agent',
      options: { getFocused: vi.fn(() => ({ name: 'agent', value: 'man' })) },
      user: { id: 'user-1' },
      isChatInputCommand: () => false,
      isAutocomplete: () => true,
      respond,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(cacheManager.refresh).toHaveBeenCalledWith('/project/one', client);
    expect(respond).toHaveBeenCalledWith([{ name: 'manager', value: 'manager' }]);
  });

  it('remembers existing thread messages before resubscribing their stream', async () => {
    const calls: string[] = [];
    const session: SessionState = {
      sessionId: 'session-old',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/one',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 10,
      lastActivityAt: 20,
      status: 'active',
    };
    const state: BotState = { version: 1, servers: {}, sessions: { 'thread-old': session }, queues: {} };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, nextSession: SessionState) => {
        state.sessions[threadId] = nextSession;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
      enqueue: vi.fn(),
    };
    const opencodeClient = {
      session: {
        create: vi.fn(),
        get: vi.fn(async () => ({ id: 'session-old' })),
        abort: vi.fn(),
        messages: vi.fn(),
        promptAsync: vi.fn(async () => undefined),
      },
    };
    const thread = { id: 'thread-old', isThread: () => true, send: vi.fn() };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn() },
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    const startTypingForThread = vi.fn();
    const createStreamHandler = vi.fn((options: { getThread(threadId: string): unknown }) => ({
      subscribe: vi.fn(async (threadId: string) => {
        calls.push(`subscribe:${threadId}:${options.getThread(threadId) === thread ? 'cached' : 'missing'}`);
      }),
      startTypingForThread,
    }));

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(async () => opencodeClient),
        getClient: vi.fn(),
        shutdownAll: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      createStreamHandler,
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
    });

    const messageListener = discordClient.on.mock.calls.find(([eventName]) => eventName === 'messageCreate')?.[1] as ((message: unknown) => Promise<void> | void) | undefined;
    await messageListener?.({
      id: 'message-1',
      author: { id: 'user-1', bot: false },
      channelId: 'thread-old',
      channel: thread,
      content: 'continue old session',
      attachments: new Map(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toEqual(['subscribe:thread-old:cached']);
    expect(opencodeClient.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'session-old' }));
    expect(startTypingForThread).toHaveBeenCalledWith('thread-old');
  });

  it('notifies the thread when runtime message forwarding fails unexpectedly', async () => {
    const session: SessionState = {
      sessionId: 'session-old',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/one',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 10,
      lastActivityAt: 20,
      status: 'active',
    };
    const state: BotState = { version: 1, servers: {}, sessions: { 'thread-old': session }, queues: {} };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn(),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
      enqueue: vi.fn(),
    };
    const thread = { id: 'thread-old', isThread: () => true, send: vi.fn(async () => undefined) };
    const discordClient = { login: vi.fn(), channels: { fetch: vi.fn() }, destroy: vi.fn(), on: vi.fn(), off: vi.fn() };
    const runtimeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(async () => { throw new Error('server unavailable'); }),
        getClient: vi.fn(),
        shutdownAll: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      createStreamHandler: vi.fn(() => ({ subscribe: vi.fn() })),
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      logger: runtimeLogger,
    });

    const messageListener = discordClient.on.mock.calls.find(([eventName]) => eventName === 'messageCreate')?.[1] as ((message: unknown) => Promise<void> | void) | undefined;
    await messageListener?.({
      id: 'message-1',
      author: { id: 'user-1', bot: false },
      channelId: 'thread-old',
      channel: thread,
      content: 'continue old session',
      attachments: new Map(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('OpenCode에 메시지를 보내지 못했습니다.'));
    expect(runtimeLogger.error).toHaveBeenCalledWith('Failed to handle Discord thread message', expect.objectContaining({ threadId: 'thread-old', err: expect.any(Error) }));
  });

  it('wires real question and permission handlers into the default stream handler', async () => {
    vi.stubEnv('OPENCODE_SHARED_SERVER_URL', 'http://127.0.0.1:49374');
    const session: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/one',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 1,
      lastActivityAt: 1,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: {
        '/project/one': {
          port: 1234,
          pid: 4321,
          url: 'http://127.0.0.1:1234',
          startedAt: 1,
          status: 'running',
        },
      },
      sessions: { 'thread-1': session },
      queues: {},
    };
    const captured = { questionHandler: undefined as unknown, permissionHandler: undefined as unknown, onUserMessage: undefined as unknown, getEventClient: undefined as unknown };
    const sessionBridge = { getDedupeSet: () => new Set<string>(), replaySessionHistory: vi.fn(async () => undefined) } as unknown as SessionBridge;
    const thread = {
      send: vi.fn(async () => ({
        createMessageComponentCollector: vi.fn(() => ({ on: vi.fn() })),
      })),
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn(async () => thread) },
      on: vi.fn(),
      off: vi.fn(),
      destroy: vi.fn(),
    };
    const streamHandler = {
      subscribe: vi.fn(),
    };
    const createStreamHandler = vi.fn((options: { questionHandler?: unknown; permissionHandler?: unknown; onUserMessage?: unknown; getEventClient?: unknown }) => {
      captured.questionHandler = options.questionHandler;
      captured.permissionHandler = options.permissionHandler;
      captured.onUserMessage = options.onUserMessage;
      captured.getEventClient = options.getEventClient;
      return streamHandler;
    });
    const questionClient = { question: { reply: vi.fn(), reject: vi.fn() } };
    const permissionClient = { permission: { reply: vi.fn() } };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn((threadId: string) => state.sessions[threadId]),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(),
        shutdownAll: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      createStreamHandler,
      sessionBridge,
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => ({ id: 'recovered-client' })),
      healthCheck: vi.fn(() => true),
    });

    expect(captured.questionHandler).toBeDefined();
    await (captured.questionHandler as { handleQuestionEvent(threadId: string, event: unknown, client: unknown): Promise<void> }).handleQuestionEvent(
      'thread-unknown',
      { request: { id: 'question-1', sessionID: 'session-1', questions: [{ header: 'Choose', question: 'Proceed?', options: [{ label: 'Yes', description: 'Continue' }] }] } },
      questionClient,
    );
    expect(questionClient.question.reject).toHaveBeenCalledWith({ requestID: 'question-1', sessionID: 'session-1' });

    expect(captured.permissionHandler).toBeDefined();
    await (captured.permissionHandler as { handlePermissionEvent(threadId: string, event: unknown, client: unknown): Promise<void> }).handlePermissionEvent(
      'thread-1',
      { request: { id: 'permission-1', sessionID: 'session-1', permission: 'write', patterns: ['src/**'] } },
      permissionClient,
    );
    expect(permissionClient.permission.reply).toHaveBeenCalledWith({ requestID: 'permission-1', reply: 'always' });
    vi.mocked(sessionBridge.replaySessionHistory).mockClear();
    const sync = (captured.onUserMessage as (threadId: string) => Promise<void>)('thread-1');
    expect(sync).toBeInstanceOf(Promise);
    await sync;
    expect(sessionBridge.replaySessionHistory).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1', sessionId: 'session-1', thread }));
    const original = { global: { event: vi.fn() } };
    const getEventClient = captured.getEventClient as (client: unknown, projectPath: string) => unknown;
    expect(getEventClient(original, '/project/one')).not.toBe(original);
    expect(getEventClient(original, '/project/one')).toBe(getEventClient(original, '/project/other'));
  });

  it('shuts down recovered servers and aborts recovered sessions not known to ServerManager', async () => {
    const server: ServerState = {
      port: 1234,
      pid: 9876,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const session: SessionState = {
      sessionId: 'session-recovered',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/recovered',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 20,
      lastActivityAt: 30,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/recovered': server },
      sessions: { 'thread-recovered': session },
      queues: {},
    };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn((projectPath: string, nextServer: ServerState) => {
        state.servers[projectPath] = nextServer;
      }),
      getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, nextSession: SessionState) => {
        state.sessions[threadId] = nextSession;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const recoveredClient = {
      session: {
        abort: vi.fn(),
      },
    };
    const serverManager = {
      ensureRunning: vi.fn(),
      getClient: vi.fn(() => undefined),
      shutdownAll: vi.fn(),
    };
    const killPid = vi.fn();

    const started = await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/recovered' }] }],
        })),
      },
      stateManager,
      serverManager,
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({
        login: vi.fn(),
        channels: { fetch: vi.fn(async () => ({ send: vi.fn() })) },
        destroy: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => recoveredClient),
      healthCheck: vi.fn(() => true),
      killPid,
    });

    await started.lifecycleController.shutdown();

    expect(serverManager.getClient).toHaveBeenCalledWith('/project/recovered');
    expect(recoveredClient.session.abort).toHaveBeenCalledWith({ sessionID: 'session-recovered' });
    expect(serverManager.shutdownAll).toHaveBeenCalledOnce();
    expect(killPid).toHaveBeenCalledWith(9876);
    expect(stateManager.setServer).toHaveBeenCalledWith('/project/recovered', { ...server, status: 'stopped' });
  });

  it('loads state and config, recovers runtime state, starts eager servers, connects Discord, and syncs commands', async () => {
    const calls: string[] = [];
    const healthyServer: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const deadServer: ServerState = {
      port: 2345,
      pid: 222,
      url: 'http://127.0.0.1:2345',
      startedAt: 20,
      status: 'running',
    };
    const activeSession: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/healthy',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const endedSession: SessionState = {
      ...activeSession,
      sessionId: 'session-ended',
      projectPath: '/project/dead',
      status: 'ended',
    };
    const state: BotState = {
      version: 1,
      servers: {
        '/project/healthy': healthyServer,
        '/project/dead': deadServer,
      },
      sessions: {
        'thread-1': activeSession,
        'thread-ended': endedSession,
      },
      queues: {
        'thread-1': [{ userId: 'user-1', content: 'kept', attachments: [], queuedAt: 50 }],
        'thread-ended': [{ userId: 'user-2', content: 'discarded', attachments: [], queuedAt: 60 }],
      },
    };
    const config = {
      discordToken: 'token',
      servers: [
        {
          serverId: 'guild-1',
          channels: [
            { channelId: 'channel-1', projectPath: '/project/healthy' },
            { channelId: 'channel-2', projectPath: '/project/eager', autoConnect: true },
          ],
        },
      ],
    };
    const clients = {
      healthy: { id: 'healthy-client' },
      eager: { id: 'eager-client' },
    };

    const stateManager = {
      load: vi.fn(() => calls.push('state.load')),
      getState: vi.fn(() => state),
      setServer: vi.fn((projectPath: string, server: ServerState) => {
        calls.push(`state.setServer:${projectPath}:${server.status}`);
        state.servers[projectPath] = server;
      }),
      getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, session: SessionState) => {
        calls.push(`state.setSession:${threadId}:${session.status}`);
        state.sessions[threadId] = session;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn((threadId: string) => state.queues[threadId] ?? []),
      clearQueue: vi.fn((threadId: string) => {
        calls.push(`state.clearQueue:${threadId}`);
        state.queues[threadId] = [];
      }),
    };
    const configLoader = {
      load: vi.fn(async () => {
        calls.push('config.load');
      }),
      getConfig: vi.fn(() => config),
    };
    const serverManager = {
      ensureRunning: vi.fn(async (projectPath: string) => {
        calls.push(`server.ensureRunning:${projectPath}`);
        return projectPath === '/project/eager' ? clients.eager : clients.healthy;
      }),
      getClient: vi.fn((projectPath: string) => (projectPath === '/project/healthy' ? clients.healthy : undefined)),
    };
    const cacheManager = {
      refresh: vi.fn(async (projectPath: string) => {
        calls.push(`cache.refresh:${projectPath}`);
      }),
    };
    const streamHandler = {
      subscribe: vi.fn(async (threadId: string, sessionId: string, client: unknown, dedupe?: Set<string>, projectPath?: string) => {
        void client;
        void dedupe;
        calls.push(`stream.subscribe:${threadId}:${sessionId}:${projectPath}`);
      }),
    };
    const discordClient = {
      login: vi.fn(async (token: string) => calls.push(`discord.login:${token}`)),
    };

    await startBot({
      configLoader,
      stateManager,
      serverManager,
      cacheManager,
      streamHandler,
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(async (token, guildId) => {
        calls.push(`deploy:${token}:${guildId}`);
      }),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(async () => {
        calls.push('preflight');
      }),
      isPidAlive: vi.fn((pid) => pid === 111),
      createClient: vi.fn((url) => {
        calls.push(`client.create:${url}`);
        return clients.healthy;
      }),
      healthCheck: vi.fn(async (client) => client === clients.healthy),
      threadExists: vi.fn(() => true),
      subscribeProjectEvents: vi.fn(async (projectPath, client) => {
        void client;
        calls.push(`project.subscribe:${projectPath}`);
      }),
    });

    expect(calls).toEqual([
      'preflight',
      'state.load',
      'config.load',
      'client.create:http://127.0.0.1:1234',
      'state.setServer:/project/dead:stopped',
      'stream.subscribe:thread-1:session-1:/project/healthy',
      'state.clearQueue:thread-ended',
      'server.ensureRunning:/project/eager',
      'project.subscribe:/project/eager',
      'deploy:token:guild-1',
      'discord.login:token',
    ]);
    expect(state.queues['thread-1']).toHaveLength(1);
    expect(state.queues['thread-ended']).toHaveLength(0);
  });

  it('marks a recovered session ended when its Discord thread no longer exists', async () => {
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const session: SessionState = {
      sessionId: 'session-deleted-thread',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/healthy',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/healthy': server },
      sessions: { 'thread-deleted': session },
      queues: {},
    };
    const client = { id: 'healthy-client' };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn((projectPath: string, nextServer: ServerState) => {
        state.servers[projectPath] = nextServer;
      }),
      getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, nextSession: SessionState) => {
        state.sessions[threadId] = nextSession;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn((threadId: string) => state.queues[threadId] ?? []),
      clearQueue: vi.fn(),
    };
    const streamHandler = { subscribe: vi.fn() };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/healthy' }] }],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => client),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler,
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => client),
      healthCheck: vi.fn(() => true),
      threadExists: vi.fn(() => false),
    });

    expect(stateManager.setSession).toHaveBeenCalledWith('thread-deleted', { ...session, status: 'ended' });
    expect(streamHandler.subscribe).not.toHaveBeenCalled();
  });

  it('re-attaches the shared OpenCode server so its threads resubscribe after a restart', async () => {
    const previousUrl = process.env.OPENCODE_SHARED_SERVER_URL;
    const previousProject = process.env.OPENCODE_SHARED_SERVER_PROJECT;
    process.env.OPENCODE_SHARED_SERVER_URL = 'http://127.0.0.1:1234';
    process.env.OPENCODE_SHARED_SERVER_PROJECT = '/project/shared';
    const server: ServerState = {
      port: 1234,
      pid: 0,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const session: SessionState = {
      sessionId: 'session-shared',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/shared',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/shared': server },
      sessions: { 'thread-shared': session },
      queues: {},
    };
    const client = { id: 'shared-client' };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn((projectPath: string, nextServer: ServerState) => {
        state.servers[projectPath] = nextServer;
      }),
      getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, nextSession: SessionState) => {
        state.sessions[threadId] = nextSession;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn((threadId: string) => state.queues[threadId] ?? []),
      clearQueue: vi.fn(),
    };
    const streamHandler = { subscribe: vi.fn() };
    const serverManager = {
      ensureRunning: vi.fn(async () => {
        stateManager.setServer('/project/shared', server);
        return client;
      }),
      getClient: vi.fn(() => client),
    };

    try {
      await startBot({
        configLoader: {
          load: vi.fn(),
          getConfig: vi.fn(() => ({
            discordToken: 'token',
            servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/shared' }] }],
          })),
        },
        stateManager,
        serverManager,
        cacheManager: { refresh: vi.fn() },
        streamHandler,
        createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
        deployCommands: vi.fn(),
        getCommandDefinitions: vi.fn(() => []),
        preflight: vi.fn(),
        isPidAlive: vi.fn(() => false),
        createClient: vi.fn(() => client),
        healthCheck: vi.fn(() => true),
        threadExists: vi.fn(() => true),
      });
    } finally {
      if (previousUrl === undefined) delete process.env.OPENCODE_SHARED_SERVER_URL;
      else process.env.OPENCODE_SHARED_SERVER_URL = previousUrl;
      if (previousProject === undefined) delete process.env.OPENCODE_SHARED_SERVER_PROJECT;
      else process.env.OPENCODE_SHARED_SERVER_PROJECT = previousProject;
    }

    expect(serverManager.ensureRunning).toHaveBeenCalledWith('/project/shared');
    expect(streamHandler.subscribe).toHaveBeenCalledWith(
      'thread-shared',
      'session-shared',
      client,
      expect.any(Set),
      '/project/shared',
    );
    expect(state.sessions['thread-shared']?.status).toBe('active');
  });

  it('auto-connects only unattached sessions found during startup reconciliation', async () => {
    const knownSession: SessionState = {
      sessionId: 'known-session',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/eager',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const newSession = { id: 'new-session', title: 'Created while offline' };
    const client = {
      session: {
        list: vi.fn(async () => ({ data: { data: [{ id: 'known-session' }, newSession] } })),
      },
    };
    const autoConnectSession = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/eager', autoConnect: true }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => ({
          version: 1,
          servers: {},
          sessions: { 'thread-known': knownSession },
          queues: {},
        })),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(async () => client),
        getClient: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      autoConnectSession,
    });

    expect(client.session.list).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(autoConnectSession).toHaveBeenCalledOnce());
    expect(autoConnectSession).toHaveBeenCalledWith('/project/eager', newSession, client);
  });

  it('does not auto-connect sessions from other projects during startup reconciliation', async () => {
    const currentProjectSession = { id: 'current-session', location: { directory: '/project/eager' } };
    const otherProjectSession = { id: 'other-session', location: { directory: '/project/other' } };
    const client = {
      session: {
        list: vi.fn(async () => ({ data: { data: [currentProjectSession, otherProjectSession] } })),
      },
    };
    const autoConnectSession = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/eager', autoConnect: true }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => ({ version: 1, servers: {}, sessions: {}, queues: {} })),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(async () => client),
        getClient: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      autoConnectSession,
    });

    await vi.waitFor(() => expect(autoConnectSession).toHaveBeenCalledOnce());
    expect(autoConnectSession).toHaveBeenCalledWith('/project/eager', currentProjectSession, client);
  });

  it('uses a healthy recovered server client for session recovery when ServerManager has no client', async () => {
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const session: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/recovered',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/recovered': server },
      sessions: { 'thread-1': session },
      queues: {},
    };
    const recoveredClient = { id: 'recovered-client' };
    const streamHandler = { subscribe: vi.fn() };
    const cacheManager = { refresh: vi.fn() };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/recovered' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn((projectPath: string, nextServer: ServerState) => {
          state.servers[projectPath] = nextServer;
        }),
        getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
        removeServer: vi.fn(),
        getSession: vi.fn((threadId: string) => state.sessions[threadId]),
        setSession: vi.fn((threadId: string, nextSession: SessionState) => {
          state.sessions[threadId] = nextSession;
        }),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => undefined),
      },
      cacheManager,
      streamHandler,
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => recoveredClient),
      healthCheck: vi.fn(() => true),
      threadExists: vi.fn(() => true),
    });

    expect(cacheManager.refresh).not.toHaveBeenCalled();
    expect(streamHandler.subscribe).toHaveBeenCalledWith('thread-1', 'session-1', recoveredClient, expect.any(Set), '/project/recovered');
  });

  it('registers healthy recovered server clients with ServerManager when supported', async () => {
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/recovered': server },
      sessions: {},
      queues: {},
    };
    const recoveredClient = { id: 'recovered-client' };
    const registerRecovered = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/recovered' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn(),
        getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => undefined),
        registerRecovered,
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn(), on: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => recoveredClient),
      healthCheck: vi.fn(() => true),
    });

    expect(registerRecovered).toHaveBeenCalledWith('/project/recovered', recoveredClient, server);
  });

  it('uses the default Discord client to find recovered threads after login', async () => {
    const calls: string[] = [];
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const session: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/recovered',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/recovered': server },
      sessions: { 'thread-1': session },
      queues: {},
    };
    const recoveredClient = { id: 'recovered-client' };
    const thread = {
      send: vi.fn(async (message: string) => {
        calls.push(`thread.send:${message}`);
      }),
    };
    const discordClient = {
      login: vi.fn(async () => {
        calls.push('discord.login');
      }),
      channels: {
        fetch: vi.fn(async (threadId: string) => {
          calls.push(`channels.fetch:${threadId}`);
          return thread;
        }),
      },
    };
    const streamHandler = {
      subscribe: vi.fn(async (threadId: string, sessionId: string, client: unknown) => {
        void client;
        calls.push(`stream.subscribe:${threadId}:${sessionId}`);
      }),
    };
    const createStreamHandler = vi.fn((options: { getThread(threadId: string): Promise<unknown> | unknown }) => {
      return {
        subscribe: vi.fn(async (threadId: string, sessionId: string, client: unknown) => {
          expect(await options.getThread(threadId)).toBe(thread);
          await streamHandler.subscribe(threadId, sessionId, client);
        }),
      };
    });

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/recovered' }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn((projectPath: string, nextServer: ServerState) => {
          state.servers[projectPath] = nextServer;
        }),
        getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
        removeServer: vi.fn(),
        getSession: vi.fn((threadId: string) => state.sessions[threadId]),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => undefined),
      },
      cacheManager: { refresh: vi.fn() },
      createDiscordClient: vi.fn(() => discordClient),
      createStreamHandler,
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => recoveredClient),
      healthCheck: vi.fn(() => true),
    });

    expect(createStreamHandler).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(streamHandler.subscribe).toHaveBeenCalledWith('thread-1', 'session-1', recoveredClient);
    });
    expect(thread.send).not.toHaveBeenCalledWith('Bot restarted. Session reconnected.');
    expect(calls.indexOf('stream.subscribe:thread-1:session-1')).toBeGreaterThan(calls.indexOf('discord.login'));
  });

  it('reuses a recovered healthy client for an autoConnect project instead of starting another server', async () => {
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const recoveredClient = {
      session: {
        list: vi.fn(async () => []),
      },
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/eager': server },
      sessions: {},
      queues: {},
    };
    const ensureRunning = vi.fn(async () => ({ id: 'duplicate-client' }));
    const cacheManager = { refresh: vi.fn() };
    const subscribeProjectEvents = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/eager', autoConnect: true }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => state),
        setServer: vi.fn((projectPath: string, nextServer: ServerState) => {
          state.servers[projectPath] = nextServer;
        }),
        getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning,
        getClient: vi.fn(() => undefined),
      },
      cacheManager,
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => recoveredClient),
      healthCheck: vi.fn(() => true),
      subscribeProjectEvents,
    });

    expect(ensureRunning).not.toHaveBeenCalled();
    expect(cacheManager.refresh).not.toHaveBeenCalled();
    expect(subscribeProjectEvents).toHaveBeenCalledWith('/project/eager', recoveredClient);
    expect(recoveredClient.session.list).toHaveBeenCalledOnce();
  });

  it('subscribes to project events by default and auto-connects unattached session.created events', async () => {
    const knownSession: SessionState = {
      sessionId: 'known-session',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/eager',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const newSession = { id: 'new-session', title: 'Created from event' };
    async function* events(): AsyncIterable<unknown> {
      yield { payload: { type: 'session.created', info: { id: 'known-session' } } };
      yield { payload: { type: 'session.created', info: { id: 'child-session', parentID: 'known-session' } } };
      yield { payload: { type: 'session.created', info: { id: 'other-project', location: { directory: '/project/private' } } } };
      yield { payload: { type: 'session.created', info: newSession } };
    }
    const client = {
      global: { event: vi.fn(() => events()) },
      session: { list: vi.fn(async () => []) },
    };
    const autoConnectSession = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/eager', autoConnect: true }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => ({ version: 1, servers: {}, sessions: { 'thread-known': knownSession }, queues: {} })),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(async () => client),
        getClient: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      autoConnectSession,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.global.event).toHaveBeenCalledOnce();
    expect(autoConnectSession).toHaveBeenCalledOnce();
    expect(autoConnectSession).toHaveBeenCalledWith('/project/eager', newSession, client);
  });

  it('reconciles auto-connect sessions when the project event stream ends cleanly', async () => {
    async function* events(): AsyncIterable<unknown> {
      return;
    }
    const missedSession = { id: 'missed-session', title: 'Created after stream ended', directory: '/project/eager' };
    const client = {
      global: { event: vi.fn(() => events()) },
      session: { list: vi.fn(async () => [{ id: 'child-session', parentID: 'missed-session' }, missedSession]) },
    };
    const autoConnectSession = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/eager', autoConnect: true }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => ({ version: 1, servers: {}, sessions: {}, queues: {} })),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(async () => client),
        getClient: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      autoConnectSession,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.global.event).toHaveBeenCalledOnce();
    expect(client.session.list).toHaveBeenCalledTimes(2);
    expect(autoConnectSession).toHaveBeenCalledWith('/project/eager', missedSession, client);
  });

  it('subscribes to SDK SSE result project event streams', async () => {
    const newSession = { id: 'new-session', title: 'Created from SDK stream' };
    async function* events(): AsyncIterable<unknown> {
      yield { payload: { type: 'session.created', info: newSession } };
    }
    const client = {
      global: { event: vi.fn(async () => ({ stream: events() })) },
      session: { list: vi.fn(async () => []) },
    };
    const autoConnectSession = vi.fn();

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/eager', autoConnect: true }] }],
        })),
      },
      stateManager: {
        load: vi.fn(),
        getState: vi.fn(() => ({ version: 1, servers: {}, sessions: {}, queues: {} })),
        setServer: vi.fn(),
        getServer: vi.fn(),
        removeServer: vi.fn(),
        getSession: vi.fn(),
        setSession: vi.fn(),
        removeSession: vi.fn(),
        getQueue: vi.fn(() => []),
        clearQueue: vi.fn(),
      },
      serverManager: {
        ensureRunning: vi.fn(async () => client),
        getClient: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn() })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      autoConnectSession,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.global.event).toHaveBeenCalledOnce();
    expect(autoConnectSession).toHaveBeenCalledOnce();
    expect(autoConnectSession).toHaveBeenCalledWith('/project/eager', newSession, client);
  });

  it('auto-connects a missed session by default by creating a thread and persisting the mapping', async () => {
    const missedSession = { id: 'missed-session', title: 'Missed offline session' };
    const client = {
      session: { list: vi.fn(async () => [missedSession]) },
    };
    const thread = {
      id: 'thread-auto',
      send: vi.fn(),
    };
    const parentChannel = {
      threads: {
        create: vi.fn(async (options: { name: string }) => {
          expect(options.name).toBe('Missed offline session');
          return thread;
        }),
      },
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn(async () => parentChannel) },
    };
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, session: SessionState) => {
        state.sessions[threadId] = session;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const streamHandler = { subscribe: vi.fn() };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [
            {
              serverId: 'guild-1',
              channels: [{ channelId: 'channel-auto', projectPath: '/project/eager', autoConnect: true, defaultAgent: 'plan' }],
            },
          ],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(async () => client),
        getClient: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler,
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      now: vi.fn(() => 12345),
    });

    await vi.waitFor(() => expect(parentChannel.threads.create).toHaveBeenCalledOnce());
    expect(stateManager.setSession).toHaveBeenCalledWith('thread-auto', {
      sessionId: 'missed-session',
      guildId: 'guild-1',
      channelId: 'channel-auto',
      projectPath: '/project/eager',
      agent: 'plan',
      model: null,
      createdBy: 'auto-connect',
      createdAt: 12345,
      lastActivityAt: 12345,
      userMirrorSince: 12345,
      status: 'active',
    });
    expect(streamHandler.subscribe).toHaveBeenCalledWith('thread-auto', 'missed-session', client, expect.any(Set), '/project/eager');
    expect(thread.send).toHaveBeenCalledWith('세션 `missed-session`에 자동으로 연결했습니다.');
  });

  it('retries auto-connect when the configured Discord channel was temporarily unavailable', async () => {
    const session = { id: 'retry-session', title: 'Retry session', location: { directory: '/project/eager' } };
    async function* events(): AsyncIterable<unknown> {
      yield { type: 'session.created', data: { sessionID: session.id, info: session } };
      yield { type: 'session.created', data: { sessionID: session.id, info: session } };
    }
    const client = { global: { event: vi.fn(() => events()) }, session: { list: vi.fn(async () => []) } };
    const thread = { id: 'thread-retry', send: vi.fn() };
    const parent = { threads: { create: vi.fn(async () => thread) } };
    const channels = { fetch: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(parent) };
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    await startBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => ({
        discordToken: 'token', servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/eager', autoConnect: true }] }],
      })) },
      stateManager: {
        load: vi.fn(), getState: vi.fn(() => state), getServer: vi.fn(), setServer: vi.fn(), removeServer: vi.fn(),
        getSession: vi.fn((id: string) => state.sessions[id]),
        setSession: vi.fn((id: string, next: SessionState) => { state.sessions[id] = next; }),
        removeSession: vi.fn(), getQueue: vi.fn(() => []), clearQueue: vi.fn(),
      },
      serverManager: { ensureRunning: vi.fn(async () => client), getClient: vi.fn() },
      cacheManager: { refresh: vi.fn() }, streamHandler: { subscribe: vi.fn() },
      createDiscordClient: vi.fn(() => ({ login: vi.fn(), channels })),
      deployCommands: vi.fn(), getCommandDefinitions: vi.fn(() => []), preflight: vi.fn(),
    });
    await vi.waitFor(() => expect(parent.threads.create).toHaveBeenCalledOnce());
    expect(state.sessions['thread-retry']?.sessionId).toBe('retry-session');
  });

  it('does not block history sync on a slow Discord delivery diagnostic', async () => {
    const session = (id: string): SessionState => ({
      sessionId: id, guildId: 'guild-1', channelId: 'channel-1', projectPath: '/project/eager',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1, lastActivityAt: 1,
      lastSyncedMessageId: 'old', status: 'active',
    });
    const state: BotState = {
      version: 1, servers: {}, sessions: { 'thread-1': session('session-1'), 'thread-2': session('session-2') }, queues: {},
    };
    const replaySessionHistory = vi.fn(async () => ({ latestAssistantAt: 1 }));
    const fetchFirst = vi.fn(() => new Promise<never>(() => undefined));
    const discordClient = {
      user: { id: 'bot-1' }, login: vi.fn(),
      channels: { fetch: vi.fn(async (id: string) => ({
        messages: { fetch: id === 'thread-1' ? fetchFirst : vi.fn(async () => new Map()) },
        send: vi.fn(),
      })) },
    };
    const client = { session: { list: vi.fn(async () => []) } };
    await startBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => ({
        discordToken: 'token', servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/eager', autoConnect: true }] }],
      })) },
      stateManager: {
        load: vi.fn(), getState: vi.fn(() => state), getServer: vi.fn(), setServer: vi.fn(), removeServer: vi.fn(),
        getSession: vi.fn((id: string) => state.sessions[id]), setSession: vi.fn(), removeSession: vi.fn(),
        getQueue: vi.fn(() => []), clearQueue: vi.fn(),
      },
      serverManager: { ensureRunning: vi.fn(async () => client), getClient: vi.fn(() => client) },
      cacheManager: { refresh: vi.fn() }, streamHandler: { subscribe: vi.fn() },
      sessionBridge: { getDedupeSet: () => new Set<string>(), replaySessionHistory } as unknown as SessionBridge,
      createDiscordClient: vi.fn(() => discordClient), threadExists: vi.fn(async () => true),
      deployCommands: vi.fn(), getCommandDefinitions: vi.fn(() => []), preflight: vi.fn(),
    });
    replaySessionHistory.mockClear();
    await vi.waitFor(() => expect(fetchFirst).toHaveBeenCalledOnce(), { timeout: 2500 });
    await vi.waitFor(() => expect(replaySessionHistory).toHaveBeenCalledTimes(2), { timeout: 1000 });
  });

  it('retires only a session confirmed missing by OpenCode during polling', async () => {
    const session: SessionState = {
      sessionId: 'missing-session', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/project/one',
      agent: 'build', model: null, createdBy: 'auto-connect', createdAt: 1, lastActivityAt: 1,
      lastSyncedMessageId: 'old', status: 'active',
    };
    const state: BotState = { version: 1, servers: {}, sessions: { 'thread-missing': session }, queues: {} };
    const stateManager = {
      load: vi.fn(), getState: vi.fn(() => state), getServer: vi.fn(), setServer: vi.fn(), removeServer: vi.fn(),
      getSession: vi.fn((id: string) => state.sessions[id]),
      setSession: vi.fn((id: string, next: SessionState) => { state.sessions[id] = next; }),
      removeSession: vi.fn(), getQueue: vi.fn(() => []), clearQueue: vi.fn(),
    };
    const thread = { send: vi.fn(async () => undefined) };
    const replaySessionHistory = vi.fn(async () => { throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'OpenCode session was not found', { status: 404 }); });
    const unsubscribe = vi.fn();
    await startBot({
      configLoader: { load: vi.fn(), getConfig: vi.fn(() => ({ discordToken: 'token', servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/one' }] }] })) },
      stateManager, serverManager: { getClient: vi.fn(() => ({ session: {} })), ensureRunning: vi.fn() },
      cacheManager: { refresh: vi.fn() }, streamHandler: { subscribe: vi.fn(), unsubscribe },
      sessionBridge: { getDedupeSet: () => new Set<string>(), replaySessionHistory } as unknown as SessionBridge,
      createDiscordClient: vi.fn(() => ({ login: vi.fn(), channels: { fetch: vi.fn(async () => thread) } })),
      threadExists: vi.fn(async () => true), deployCommands: vi.fn(), getCommandDefinitions: vi.fn(() => []), preflight: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await vi.waitFor(() => expect(state.sessions['thread-missing']?.status).toBe('ended'), { timeout: 3000 });
    expect(unsubscribe).toHaveBeenCalledWith('thread-missing');
    expect(thread.send).toHaveBeenCalledOnce();
  });

  it('replays existing session history into a newly auto-connected thread', async () => {
    const missedSession = { id: 'missed-session', title: 'Missed offline session' };
    const client = {
      session: { list: vi.fn(async () => [missedSession]) },
    };
    const thread = { id: 'thread-auto', send: vi.fn() };
    const parentChannel = {
      threads: { create: vi.fn(async () => thread) },
    };
    const discordClient = {
      login: vi.fn(),
      channels: { fetch: vi.fn(async () => parentChannel) },
    };
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn(),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, session: SessionState) => {
        state.sessions[threadId] = session;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const replaySessionHistory = vi.fn(async () => undefined);

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [
            {
              serverId: 'guild-1',
              channels: [{ channelId: 'channel-auto', projectPath: '/project/eager', autoConnect: true, defaultAgent: 'plan' }],
            },
          ],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(async () => client),
        getClient: vi.fn(),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler: { subscribe: vi.fn() },
      sessionBridge: { replaySessionHistory, connectToSession: vi.fn() } as unknown as SessionBridge,
      createDiscordClient: vi.fn(() => discordClient),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      now: vi.fn(() => 12345),
    });

    await vi.waitFor(() => expect(replaySessionHistory).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-auto',
      sessionId: 'missed-session',
      projectPath: '/project/eager',
      historyLimit: 30,
    })));
  });

  it.each([
    [new Error('network'), 'active'],
    [{ code: 50013, status: 403 }, 'active'],
    [{ code: 10008, status: 404 }, 'active'],
    [{ status: 404, message: 'other resource' }, 'active'],
    [{ code: 10003, status: 404 }, 'ended'],
    [{ status: 404, message: 'Unknown Channel' }, 'ended'],
  ] as const)('isolates recovery fetch errors and ends only confirmed missing channels: %j', async (error, expectedStatus) => {
    const server: ServerState = {
      port: 1234,
      pid: 111,
      url: 'http://127.0.0.1:1234',
      startedAt: 10,
      status: 'running',
    };
    const session: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/project/recovered',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 30,
      lastActivityAt: 40,
      status: 'active',
    };
    const state: BotState = {
      version: 1,
      servers: { '/project/recovered': server },
      sessions: { 'thread-missing': session },
      queues: {},
    };
    const stateManager = {
      load: vi.fn(),
      getState: vi.fn(() => state),
      setServer: vi.fn(),
      getServer: vi.fn((projectPath: string) => state.servers[projectPath]),
      removeServer: vi.fn(),
      getSession: vi.fn((threadId: string) => state.sessions[threadId]),
      setSession: vi.fn((threadId: string, nextSession: SessionState) => {
        state.sessions[threadId] = nextSession;
      }),
      removeSession: vi.fn(),
      getQueue: vi.fn(() => []),
      clearQueue: vi.fn(),
    };
    const streamHandler = { subscribe: vi.fn() };

    await startBot({
      configLoader: {
        load: vi.fn(),
        getConfig: vi.fn(() => ({
          discordToken: 'token',
          servers: [{ serverId: 'guild-1', channels: [{ channelId: 'channel-1', projectPath: '/project/recovered' }] }],
        })),
      },
      stateManager,
      serverManager: {
        ensureRunning: vi.fn(),
        getClient: vi.fn(() => undefined),
      },
      cacheManager: { refresh: vi.fn() },
      streamHandler,
      createDiscordClient: vi.fn(() => ({
        login: vi.fn(),
        channels: { fetch: vi.fn(async () => { throw error; }) },
      })),
      deployCommands: vi.fn(),
      getCommandDefinitions: vi.fn(() => []),
      preflight: vi.fn(),
      isPidAlive: vi.fn(() => true),
      createClient: vi.fn(() => ({ id: 'recovered-client' })),
      healthCheck: vi.fn(() => true),
    });

    expect(state.sessions['thread-missing']?.status).toBe(expectedStatus);
    if (expectedStatus === 'active') {
      expect(stateManager.setSession).not.toHaveBeenCalled();
      expect(state.sessions['thread-missing']).toBe(session);
    } else {
      expect(stateManager.setSession).toHaveBeenCalledExactlyOnceWith('thread-missing', { ...session, status: 'ended' });
    }
    expect(streamHandler.subscribe).not.toHaveBeenCalled();
  });
});
