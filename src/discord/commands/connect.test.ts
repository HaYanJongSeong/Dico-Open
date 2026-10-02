import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import type { BotState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createConnectCommandHandler, type ConnectCommandDependencies } from './connect.js';

function createInteraction(options: { channel?: unknown; sessionId?: string; title?: string | null } = {}): ChatInputCommandInteraction {
  return {
    channelId: 'channel-1',
    guildId: 'guild-1',
    user: { id: 'user-1' },
    channel: options.channel ?? { threads: { create: vi.fn(async () => ({ id: 'thread-1', send: vi.fn() })) } },
    options: {
      getString: vi.fn((name: string, required?: boolean) => {
        if (name === 'session') {
          return options.sessionId ?? (required ? 'session-1' : null);
        }
        if (name === 'title') {
          return options.title ?? null;
        }
        return null;
      }),
    },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} }): ConnectCommandDependencies {
  return {
    stateManager: { getState: vi.fn(() => state) },
    serverManager: { ensureRunning: vi.fn(async () => ({ session: {} })) },
    sessionBridge: { connectToSession: vi.fn(async () => undefined) },
  };
}

describe('createConnectCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo', defaultAgent: 'build', connectHistoryLimit: 5 };

  it('creates a thread and connects it to an unattached OpenCode session', async () => {
    const thread = { id: 'thread-1', send: vi.fn(async () => undefined) };
    const channel = { threads: { create: vi.fn(async () => thread) } };
    const deps = createDeps();
    const interaction = createInteraction({ channel, title: 'Existing session' });

    await createConnectCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(deps.serverManager.ensureRunning).toHaveBeenCalledWith('/repo');
    expect(channel.threads.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Existing session' }));
    expect(deps.sessionBridge.connectToSession).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      sessionId: 'session-1',
      historyLimit: 5,
      thread,
    }));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('session-1') }));
  });

  it('uses the configured channel model when connecting to an existing session', async () => {
    const thread = { id: 'thread-1', send: vi.fn(async () => undefined) };
    const channel = { threads: { create: vi.fn(async () => thread) } };
    const deps = createDeps();
    const modelChannelConfig: ChannelConfig = { ...channelConfig, model: 'google/gemini-3.5-flash' };

    await createConnectCommandHandler(deps)(createInteraction({ channel }), { correlationId: 'corr-1', channelConfig: modelChannelConfig });

    expect(deps.sessionBridge.connectToSession).toHaveBeenCalledWith(expect.objectContaining({
      model: 'google/gemini-3.5-flash',
    }));
  });

  it('rejects sessions already attached to another thread', async () => {
    const deps = createDeps({
      version: 1,
      servers: {},
      queues: {},
      sessions: {
        'other-thread': {
          sessionId: 'session-1',
          guildId: 'guild-1',
          channelId: 'channel-1',
          projectPath: '/repo',
          agent: 'build',
          model: null,
          createdBy: 'user-1',
          createdAt: 1000,
          lastActivityAt: 1000,
          status: 'active',
        },
      },
    });

    await expect(createConnectCommandHandler(deps)(createInteraction(), { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.SESSION_ALREADY_ATTACHED,
    });

    expect(deps.serverManager.ensureRunning).not.toHaveBeenCalled();
  });
});
