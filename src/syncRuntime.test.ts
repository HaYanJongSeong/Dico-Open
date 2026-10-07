import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBot, type StartedBot } from './index.js';
import type { SessionBridge } from './opencode/sessionBridge.js';
import type { BotState, SessionState } from './state/types.js';

const bots: StartedBot[] = [];
afterEach(() => {
  for (const bot of bots.splice(0)) bot.lifecycleController.dispose();
  vi.useRealTimers();
});

async function setup(autoConnect = false) {
  const session = (projectPath: string, sessionId: string): SessionState => ({
    projectPath, sessionId, guildId: 'guild', channelId: projectPath,
    agent: 'build', model: null, createdBy: 'user', createdAt: 1, lastActivityAt: 1,
    lastSyncedMessageId: 'old', status: 'active',
  });
  const state: BotState = {
    version: 1, queues: {},
    servers: { '/a': { port: 1234, pid: 1, url: 'http://localhost:1234', status: 'running', startedAt: 1 } },
    sessions: { 'thread-a': session('/a', 'session-a'), 'thread-b': session('/b', 'session-b') },
  };
  const client = { session: { list: vi.fn(async () => []) } };
  const replaySessionHistory = vi.fn(async () => ({}));
  const discord = { login: vi.fn(), on: vi.fn(), off: vi.fn(), destroy: vi.fn(),
    channels: { fetch: vi.fn(async (id: string) => ({ id, send: vi.fn() })) } };
  const bot = await startBot({
    configLoader: { load: vi.fn(), getConfig: () => ({ discordToken: 'token', servers: [{
      serverId: 'guild', channels: [{ channelId: '/a', projectPath: '/a', autoConnect }, { channelId: '/b', projectPath: '/b' }],
    }] }) },
    stateManager: {
      load: vi.fn(), getState: () => state, getServer: (p) => state.servers[p], setServer: vi.fn(), removeServer: vi.fn(),
      getSession: (id) => state.sessions[id], setSession: (id, next) => { state.sessions[id] = next; },
      removeSession: vi.fn(), getQueue: () => [], clearQueue: vi.fn(),
    },
    serverManager: { ensureRunning: vi.fn(async () => client), getClient: (p) => p === '/a' ? client : undefined },
    cacheManager: { refresh: vi.fn() }, streamHandler: { subscribe: vi.fn() },
    sessionBridge: { getDedupeSet: () => new Set(), replaySessionHistory } as unknown as SessionBridge,
    createDiscordClient: () => discord, threadExists: async () => true,
    createClient: () => client, isPidAlive: () => true, healthCheck: () => true,
    deployCommands: vi.fn(), getCommandDefinitions: () => [], preflight: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  bots.push(bot);
  const listener = discord.on.mock.calls.find(([name]) => name === 'interactionCreate')?.[1] as (i: unknown) => Promise<void>;
  const sync = async () => {
    await listener({ id: 'interaction', channelId: '/a', guildId: 'guild', commandName: 'sync', user: { id: 'user' },
      isChatInputCommand: () => true, isAutocomplete: () => false,
      options: { getSubcommand: () => 'now' }, deferReply: vi.fn(), editReply: vi.fn(), reply: vi.fn(), followUp: vi.fn() });
    await new Promise<void>((resolve) => process.nextTick(resolve));
  };
  replaySessionHistory.mockClear();
  return { bot, client, state, replaySessionHistory, sync };
}

describe('동기화 런타임 격리', () => {
  it('/connect는 구독 전에 스레드를 캐시에 등록하고 프로젝트 경로를 전달한다', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const thread = { id: 'new-thread', send: vi.fn(async () => undefined) };
    const client = { session: { get: vi.fn(async () => ({ id: 'existing-session' })), messages: vi.fn(async () => []) } };
    const discord = { login: vi.fn(), on: vi.fn(), off: vi.fn(), destroy: vi.fn(),
      channels: { fetch: vi.fn() } };
    const subscribe = vi.fn();
    const bot = await startBot({
      configLoader: { load: vi.fn(), getConfig: () => ({ discordToken: 'token', servers: [{
        serverId: 'guild', channels: [{ channelId: '/a', projectPath: '/a', autoConnect: false }],
      }] }) },
      stateManager: {
        load: vi.fn(), getState: () => state, getServer: vi.fn(), setServer: vi.fn(), removeServer: vi.fn(),
        getSession: (id) => state.sessions[id], setSession: (id, next) => { state.sessions[id] = next; },
        removeSession: vi.fn(), getQueue: () => [], clearQueue: vi.fn(),
      },
      serverManager: { ensureRunning: vi.fn(async () => client), getClient: () => client },
      cacheManager: { refresh: vi.fn() }, createDiscordClient: () => discord,
      createStreamHandler: ({ getThread }) => ({ subscribe: subscribe.mockImplementation((id) => {
        expect(getThread(id)).toBe(thread);
      }) }),
      deployCommands: vi.fn(), getCommandDefinitions: () => [], preflight: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    bots.push(bot);
    const listener = discord.on.mock.calls.find(([name]) => name === 'interactionCreate')?.[1] as (i: unknown) => Promise<void>;
    const editReply = vi.fn();
    await listener({ id: 'connect-interaction', channelId: '/a', guildId: 'guild', commandName: 'connect', user: { id: 'user' },
      channel: { threads: { create: vi.fn(async () => thread) } },
      isChatInputCommand: () => true, isAutocomplete: () => false,
      options: { getString: (name: string) => name === 'session' ? 'existing-session' : null },
      deferReply: vi.fn(), editReply, reply: vi.fn(), followUp: vi.fn() });
    await vi.waitFor(() => expect(editReply).toHaveBeenCalled());
    expect(subscribe).toHaveBeenCalledWith('new-thread', 'existing-session', client, expect.any(Set), '/a');
    expect(state.sessions['new-thread']?.sessionId).toBe('existing-session');
  });

  it('서버가 없는 프로젝트를 다른 프로젝트 클라이언트로 조회하지 않는다', async () => {
    const { sync, replaySessionHistory, state } = await setup();
    await sync();
    expect(replaySessionHistory).toHaveBeenCalledOnce();
    expect(replaySessionHistory).toHaveBeenCalledWith(expect.objectContaining({ projectPath: '/a' }));
    expect(state.sessions['thread-b']?.status).toBe('active');
  });

  it('발견 및 제목 조회 실패가 정상 세션의 기록 동기화를 막지 않는다', async () => {
    const { sync, replaySessionHistory, client } = await setup(true);
    client.session.list.mockRejectedValue(new Error('list unavailable'));
    await sync();
    expect(replaySessionHistory).toHaveBeenCalledWith(expect.objectContaining({ projectPath: '/a' }));
  });

  it.each(['dispose', 'shutdown'] as const)('종료(%s) 후 동기화 타이머를 실행하지 않는다', async (method) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { bot, replaySessionHistory } = await setup();
    await bot.lifecycleController[method]();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(replaySessionHistory).not.toHaveBeenCalled();
  });

  it('진행 중인 조회를 종료해도 다음 타이머를 예약하지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { bot, replaySessionHistory } = await setup();
    let finish!: (value: {}) => void;
    replaySessionHistory.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(replaySessionHistory).toHaveBeenCalledOnce();
    bot.lifecycleController.dispose();
    finish({});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(replaySessionHistory).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
