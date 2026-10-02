import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import type { BotState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createStatusCommandHandler, type StatusCommandDependencies } from './status.js';

describe('createStatusCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo' };
  const state: BotState = {
    version: 1,
    servers: { '/repo': { port: 4096, pid: 123, url: 'http://127.0.0.1:4096', startedAt: 1000, status: 'running' } },
    queues: { 'thread-1': [{ userId: 'user-2', content: 'queued', attachments: [], queuedAt: 1 }] },
    sessions: {
      'thread-1': {
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
  };

  it('shows server and active session overview for a configured channel', async () => {
    const interaction = { channelId: 'channel-1', channel: null, reply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: StatusCommandDependencies = { stateManager: { getState: vi.fn(() => state) } };

    await createStatusCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ title: 'OpenCode 상태' }) })] }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ fields: expect.arrayContaining([expect.objectContaining({ name: '활성 세션', value: '1' })]) }) })] }));
  });

  it('rejects status from a thread context', async () => {
    const deps: StatusCommandDependencies = { stateManager: { getState: vi.fn(() => state) } };

    await expect(createStatusCommandHandler(deps)({ channelId: 'thread-1', channel: { parentId: 'channel-1' } } as unknown as ChatInputCommandInteraction, {
      correlationId: 'corr-1',
      channelConfig,
    })).rejects.toMatchObject({ code: ErrorCode.DISCORD_API_ERROR });
  });

  it('truncates large active session lists to fit Discord embed limits', async () => {
    const manySessions = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`thread-${index}`, {
      sessionId: `session-${index}`,
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: `agent-${index}-${'x'.repeat(40)}`,
      model: null,
      createdBy: `user-${index}`,
      createdAt: 1000,
      lastActivityAt: 1000,
      status: 'active' as const,
    }]));
    const deps: StatusCommandDependencies = {
      stateManager: { getState: vi.fn(() => ({ ...state, sessions: manySessions })) },
    };
    const interaction = { channelId: 'channel-1', channel: null, reply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;

    await createStatusCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const replyOptions = vi.mocked(interaction.reply).mock.calls[0]?.[0] as { embeds?: Array<{ data: { fields?: Array<{ name: string; value: string }> } }> } | undefined;
    const embed = replyOptions?.embeds?.[0];
    const threadsField = embed?.data.fields?.find((field: { name: string; value: string }) => field.name === '스레드');
    expect(threadsField?.value.length ?? 0).toBeLessThanOrEqual(1024);
    expect(threadsField?.value).toContain('생략됨');
  });

  it('shows stream state and retry failures for active sessions when telemetry is available', async () => {
    const interaction = { channelId: 'channel-1', channel: null, reply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: StatusCommandDependencies = {
      stateManager: { getState: vi.fn(() => state) },
      streamStatusProvider: { getStatus: vi.fn(() => ({ state: 'retrying', failures: 2 })) },
    };

    await createStatusCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const replyOptions = vi.mocked(interaction.reply).mock.calls[0]?.[0] as { embeds?: Array<{ data: { fields?: Array<{ name: string; value: string }> } }> } | undefined;
    const threads = replyOptions?.embeds?.[0]?.data.fields?.find((field) => field.name === '스레드')?.value ?? '';
    expect(threads).toContain('스트림 retrying');
    expect(threads).toContain('실패 2');
  });
});
