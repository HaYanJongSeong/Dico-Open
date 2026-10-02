import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../utils/errors.js';
import { createInterruptCommandHandler, type InterruptCommandDependencies } from './interrupt.js';

function createInteraction(channel: unknown = { id: 'thread-1', parentId: 'channel-1' }): ChatInputCommandInteraction {
  return {
    channel,
    channelId: 'thread-1',
    reply: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(overrides: Partial<InterruptCommandDependencies> = {}): InterruptCommandDependencies {
  return {
    stateManager: {
      getSession: vi.fn(() => ({
        sessionId: 'session-1',
        guildId: 'guild-1',
        channelId: 'channel-1',
        projectPath: '/repo',
        agent: 'build',
        model: null,
        createdBy: 'user-1',
        createdAt: 1000,
        lastActivityAt: 1000,
        status: 'active' as const,
      })),
      clearQueue: vi.fn(),
    },
    serverManager: { getClient: vi.fn(() => ({ session: { abort: vi.fn(async () => undefined) } })) },
    sessionBridge: { abortSession: vi.fn(async () => undefined) },
    ...overrides,
  };
}

describe('createInterruptCommandHandler', () => {
  it('aborts the mapped session, clears the queue, and confirms in the thread', async () => {
    const deps = createDeps();
    const interaction = createInteraction();

    await createInterruptCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(deps.stateManager.getSession).toHaveBeenCalledWith('thread-1');
    expect(deps.sessionBridge.abortSession).toHaveBeenCalledWith('thread-1', expect.objectContaining({ session: expect.any(Object) }));
    expect(deps.stateManager.clearQueue).toHaveBeenCalledWith('thread-1');
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '세션을 중단하고 대기열을 비웠습니다.' });
  });

  it('defers before aborting the session', async () => {
    const events: string[] = [];
    const deps = createDeps({ sessionBridge: { abortSession: vi.fn(async () => { events.push('abortSession'); }) } });
    const interaction = createInteraction();
    vi.mocked(interaction.deferReply).mockImplementation(async () => { events.push('deferReply'); return {} as Awaited<ReturnType<ChatInputCommandInteraction['deferReply']>>; });

    await createInterruptCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    expect(events).toEqual(['deferReply', 'abortSession']);
  });

  it('rejects threads without an active session', async () => {
    const deps = createDeps({ stateManager: { getSession: vi.fn(() => undefined), clearQueue: vi.fn() } });
    const interaction = createInteraction();

    await expect(createInterruptCommandHandler(deps)(interaction, { correlationId: 'corr-1' })).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    });
  });
});
