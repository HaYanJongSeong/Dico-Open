import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import type { SessionState } from '../../state/types.js';
import { createRestartCommandHandler, type RestartCommandDependencies } from './restart.js';

const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo' };

function createSession(threadId: string): SessionState {
  return { sessionId: `session-${threadId}`, guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo', agent: 'build', model: null, createdBy: 'user-1', createdAt: 1, lastActivityAt: 1, status: 'active' };
}

function createInteraction(replyResult: unknown, userId = 'user-1'): ChatInputCommandInteraction {
  return { user: { id: userId }, channelId: 'channel-1', channel: { parentId: null }, reply: vi.fn(async () => replyResult) } as unknown as ChatInputCommandInteraction;
}

function createDeps(): RestartCommandDependencies {
  const client = { session: { abort: vi.fn(async () => undefined) } };
  const dedupeSets = new Map<string, Set<string>>();
  return {
    stateManager: { getState: vi.fn(() => ({ sessions: { 'thread-1': createSession('thread-1'), 'thread-2': createSession('thread-2') } })) },
    serverManager: { getClient: vi.fn(() => client), canRestart: vi.fn(() => true), shutdown: vi.fn(async () => undefined), ensureRunning: vi.fn(async () => client) },
    streamHandler: { unsubscribe: vi.fn(), subscribe: vi.fn(async () => undefined) },
    getDedupeSet: vi.fn((threadId: string) => dedupeSets.get(threadId) ?? dedupeSets.set(threadId, new Set()).get(threadId)!),
    cacheManager: { refresh: vi.fn(async () => undefined) },
    getThread: vi.fn((threadId: string) => ({ id: threadId, send: vi.fn(async () => undefined) })),
    logger: { error: vi.fn() },
  };
}

describe('createRestartCommandHandler', () => {
  it('refuses restart confirmation for external or recovered servers', async () => {
    const deps = createDeps();
    deps.serverManager.canRestart = vi.fn(() => false);
    const interaction = createInteraction({});

    await expect(createRestartCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      message: expect.stringContaining('재시작할 수 없습니다'),
    });
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(deps.serverManager.shutdown).not.toHaveBeenCalled();
  });

  it('refuses a stale confirmation if the server became external before the click', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const message = { createMessageComponentCollector: vi.fn(() => ({ on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) => handlers.set(event, handler)) })) };
    const deps = createDeps();
    const component = { customId: 'restart-confirm', user: { id: 'user-1' }, update: vi.fn(async () => undefined) };

    await createRestartCommandHandler(deps)(createInteraction(message), { correlationId: 'corr-1', channelConfig });
    deps.serverManager.canRestart = vi.fn(() => false);
    await handlers.get('collect')?.(component);

    expect(deps.serverManager.shutdown).not.toHaveBeenCalled();
    expect(deps.streamHandler.unsubscribe).not.toHaveBeenCalled();
    expect(component.update).toHaveBeenCalledWith({ content: '재시작에 실패했습니다. *(참조: corr-1)*', components: [] });
  });

  it('asks for restart confirmation with active session count and expires after 30 seconds', async () => {
    const message = { createMessageComponentCollector: vi.fn(() => ({ on: vi.fn() })) };
    const deps = createDeps();
    const interaction = createInteraction(message);

    await createRestartCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('활성 세션 2개가 모두 중단됩니다.'), fetchReply: true }));
    expect(message.createMessageComponentCollector).toHaveBeenCalledWith({ time: 30_000 });
    expect(deps.serverManager.shutdown).not.toHaveBeenCalled();
  });

  it('restarts server, notifies active threads, resubscribes SSE, and refreshes cache after confirmation', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const message = { createMessageComponentCollector: vi.fn(() => ({ on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) => handlers.set(event, handler)) })) };
    const deps = createDeps();
    const interaction = createInteraction(message, 'user-1');
    const component = { customId: 'restart-confirm', user: { id: 'user-1' }, reply: vi.fn(async () => undefined), update: vi.fn(async () => undefined) };

    await createRestartCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });
    await handlers.get('collect')?.(component);

    const client = await deps.serverManager.ensureRunning('/repo');
    expect(deps.serverManager.shutdown).toHaveBeenCalledWith('/repo');
    expect(deps.serverManager.ensureRunning).toHaveBeenCalledWith('/repo');
    expect(deps.cacheManager.refresh).toHaveBeenCalledWith('/repo', client);
    expect(deps.streamHandler.subscribe).toHaveBeenCalledTimes(2);
    expect(component.update).toHaveBeenCalledWith({ content: '`/repo`의 OpenCode 서버를 재시작했습니다.', components: [] });
  });

  it('defers the confirmation update before restarting OpenCode', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const message = { createMessageComponentCollector: vi.fn(() => ({ on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) => handlers.set(event, handler)) })) };
    const deps = createDeps();
    const client = { session: { abort: vi.fn(async () => undefined) } };
    deps.serverManager.ensureRunning = vi.fn(async () => client);
    const interaction = createInteraction(message, 'user-1');
    const component = {
      customId: 'restart-confirm',
      user: { id: 'user-1' },
      deferUpdate: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    };

    await createRestartCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });
    await handlers.get('collect')?.(component);

    expect(component.deferUpdate).toHaveBeenCalledBefore(vi.mocked(deps.serverManager.shutdown));
  });

  it('does not abort active sessions that will be reconnected after restart', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const message = { createMessageComponentCollector: vi.fn(() => ({ on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) => handlers.set(event, handler)) })) };
    const deps = createDeps();
    const interaction = createInteraction(message, 'user-1');
    const component = { customId: 'restart-confirm', user: { id: 'user-1' }, reply: vi.fn(async () => undefined), update: vi.fn(async () => undefined) };

    await createRestartCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });
    await handlers.get('collect')?.(component);

    const oldClient = deps.serverManager.getClient('/repo') as { session: { abort: ReturnType<typeof vi.fn> } };
    expect(oldClient.session.abort).not.toHaveBeenCalled();
    expect(deps.streamHandler.subscribe).toHaveBeenCalledWith('thread-1', 'session-thread-1', oldClient, deps.getDedupeSet('thread-1'), '/repo');
  });

  it('handles restart failures inside the confirmation collector with a bounded user-facing update and structured log', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const message = { createMessageComponentCollector: vi.fn(() => ({ on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) => handlers.set(event, handler)) })) };
    const deps = createDeps();
    deps.serverManager.ensureRunning = vi.fn(async () => { throw new Error('server failed hard'); });
    const component = { customId: 'restart-confirm', user: { id: 'user-1' }, reply: vi.fn(async () => undefined), update: vi.fn(async () => undefined) };

    await createRestartCommandHandler(deps)(createInteraction(message), { correlationId: 'corr-1', channelConfig });
    await expect(handlers.get('collect')?.(component)).resolves.toBeUndefined();

    expect(component.update).toHaveBeenCalledWith({ content: '재시작에 실패했습니다. *(참조: corr-1)*', components: [] });
    expect(component.update).not.toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('server failed hard') }));
    expect(deps.logger?.error).toHaveBeenCalledWith('Restart confirmation failed', expect.objectContaining({ correlationId: 'corr-1', projectPath: '/repo', err: expect.any(Error) }));
  });

  it('resubscribes and notifies threads when cache refresh after restart fails', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const message = { createMessageComponentCollector: vi.fn(() => ({ on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) => handlers.set(event, handler)) })) };
    const deps = createDeps();
    deps.cacheManager.refresh = vi.fn(async () => { throw new Error('cache failed'); });
    const component = { customId: 'restart-confirm', user: { id: 'user-1' }, reply: vi.fn(async () => undefined), update: vi.fn(async () => undefined) };

    await createRestartCommandHandler(deps)(createInteraction(message), { correlationId: 'corr-1', channelConfig });
    await handlers.get('collect')?.(component);

    expect(deps.streamHandler.subscribe).toHaveBeenCalledTimes(2);
    expect(deps.getThread).toHaveBeenCalledWith('thread-1');
    expect(deps.getThread).toHaveBeenCalledWith('thread-2');
    expect(component.update).toHaveBeenCalledWith({ content: '`/repo`의 OpenCode 서버를 재시작했습니다.', components: [] });
  });

  it('does not overwrite successful restart confirmation when collector later times out', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const message = {
      createMessageComponentCollector: vi.fn(() => ({ on: vi.fn((event: string, handler: (...args: unknown[]) => Promise<void>) => handlers.set(event, handler)) })),
      edit: vi.fn(async () => undefined),
    };
    const deps = createDeps();
    const component = { customId: 'restart-confirm', user: { id: 'user-1' }, reply: vi.fn(async () => undefined), update: vi.fn(async () => undefined) };

    await createRestartCommandHandler(deps)(createInteraction(message), { correlationId: 'corr-1', channelConfig });
    await handlers.get('collect')?.(component);
    await handlers.get('end')?.([], 'time');

    expect(component.update).toHaveBeenCalledWith({ content: '`/repo`의 OpenCode 서버를 재시작했습니다.', components: [] });
    expect(message.edit).not.toHaveBeenCalledWith({ content: '재시작 확인 시간이 만료되었습니다.', components: [] });
  });
});
