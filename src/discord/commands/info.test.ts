import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createInfoCommandHandler, type InfoCommandDependencies } from './info.js';

const session: SessionState = {
  sessionId: 'session-1',
  guildId: 'guild-1',
  channelId: 'channel-1',
  projectPath: '/repo',
  agent: 'build',
  model: 'anthropic/claude',
  createdBy: 'user-1',
  createdAt: 1000,
  lastActivityAt: 2000,
  status: 'active',
};

describe('createInfoCommandHandler', () => {
  it('counts usage from the nested CLI v2 message response', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1' }, deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: InfoCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), getQueue: vi.fn(() => []) },
      serverManager: { getClient: vi.fn(() => ({ session: { messages: vi.fn(async () => ({ data: { data: [{ tokens: { input: 2, output: 3 }, cost: 0.01 }] } })) } })) },
      cacheManager: { getMcpStatus: vi.fn(() => ({})) },
    };

    await createInfoCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    const fields = (vi.mocked(interaction.editReply).mock.calls[0]?.[0] as { embeds: Array<{ data: { fields: Array<{ name: string; value: string }> } }> }).embeds[0]?.data.fields ?? [];
    expect(fields.find((field) => field.name === '사용량')?.value).toBe('토큰: 5\n비용: $0.0100');
  });

  it('does not report zero usage when the SDK returns an error', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1' }, deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: InfoCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), getQueue: vi.fn(() => []) },
      serverManager: { getClient: vi.fn(() => ({ session: { messages: vi.fn(async () => ({ error: 'unavailable' })) } })) },
      cacheManager: { getMcpStatus: vi.fn(() => ({})) },
    };

    await createInfoCommandHandler(deps)(interaction, { correlationId: 'corr-1' });

    const fields = (vi.mocked(interaction.editReply).mock.calls[0]?.[0] as { embeds: Array<{ data: { fields: Array<{ name: string; value: string }> } }> }).embeds[0]?.data.fields ?? [];
    expect(fields.find((field) => field.name === '사용량')?.value).toBe('토큰: 사용 불가\n비용: 사용 불가');
  });

  it('preserves Windows path separators with inline code formatting', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1' }, deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: InfoCommandDependencies = {
      stateManager: { getSession: vi.fn(() => ({ ...session, projectPath: 'C:\\Project\\임상도' })), getQueue: vi.fn(() => []) },
      serverManager: { getClient: vi.fn(() => undefined) },
      cacheManager: { getMcpStatus: vi.fn(() => ({})) },
    };

    await createInfoCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: 'C:\\Project\\임상도' } });

    const fields = (interaction.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.embeds?.[0]?.data?.fields ?? [];
    expect(fields.find((field: { name: string }) => field.name === '프로젝트')?.value).toBe('`C:\\Project\\임상도`');
  });
  it('displays session details, queue length, MCP status, and message usage fallback', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1' }, reply: vi.fn(async () => undefined), deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: InfoCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), getQueue: vi.fn(() => [{ userId: 'u', content: 'queued', attachments: [], queuedAt: 1 }]) },
      serverManager: { getClient: vi.fn(() => ({ session: { messages: vi.fn(async () => [{ tokens: { input: 1, output: 2 }, cost: 0.01 }]) } })) },
      cacheManager: { getMcpStatus: vi.fn(() => ({ filesystem: { status: 'connected' } })) },
    };

    await createInfoCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: '/repo' } });

    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ title: '세션 정보' }) })] }));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ fields: expect.arrayContaining([expect.objectContaining({ name: '대기열', value: '1' })]) }) })] }));
  });

  it('displays session uptime in the session details embed', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1' }, reply: vi.fn(async () => undefined), deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: InfoCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), getQueue: vi.fn(() => []) },
      serverManager: { getClient: vi.fn(() => undefined) },
      cacheManager: { getMcpStatus: vi.fn(() => ({})) },
      now: () => 3_661_000,
    };

    await createInfoCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: '/repo' } });

    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ fields: expect.arrayContaining([expect.objectContaining({ name: '실행 시간', value: '1시간 1분 0초' })]) }) })] }));
  });

  it('defers before requesting usage from the SDK', async () => {
    const events: string[] = [];
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1' }, deferReply: vi.fn(async () => { events.push('deferReply'); }), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: InfoCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), getQueue: vi.fn(() => []) },
      serverManager: { getClient: vi.fn(() => ({ session: { messages: vi.fn(async () => { events.push('messages'); return []; }) } })) },
      cacheManager: { getMcpStatus: vi.fn(() => ({})) },
    };

    await createInfoCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: '/repo' } });

    expect(events).toEqual(['deferReply', 'messages']);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('defers before reading MCP cache status', async () => {
    const events: string[] = [];
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1' }, deferReply: vi.fn(async () => { events.push('deferReply'); }), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: InfoCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), getQueue: vi.fn(() => []) },
      serverManager: { getClient: vi.fn(() => ({ session: { messages: vi.fn(async () => []) } })) },
      cacheManager: { getMcpStatus: vi.fn(() => { events.push('getMcpStatus'); return {}; }) },
    };

    await createInfoCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: '/repo' } });

    expect(events).toEqual(['deferReply', 'getMcpStatus']);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('truncates oversized project and MCP field values to Discord embed bounds', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1' }, deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: InfoCommandDependencies = {
      stateManager: {
        getSession: vi.fn(() => ({ ...session, projectPath: `/repo/${'p'.repeat(2000)}` })),
        getQueue: vi.fn(() => []),
      },
      serverManager: { getClient: vi.fn(() => ({ session: { messages: vi.fn(async () => []) } })) },
      cacheManager: {
        getMcpStatus: vi.fn(() => Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
          `mcp-${index}-${'n'.repeat(60)}`,
          { status: `connected-${'s'.repeat(60)}` },
        ]))),
      },
    };

    await createInfoCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: '/repo' } });

    const replyOptions = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as { embeds?: Array<{ data: { title?: string; fields?: Array<{ name: string; value: string }> } }> } | undefined;
    const embed = replyOptions?.embeds?.[0];
    const fields = embed?.data.fields ?? [];
    const totalLength = (embed?.data.title?.length ?? 0) + fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
    expect(fields.every((field) => field.value.length <= 1024)).toBe(true);
    expect(totalLength).toBeLessThanOrEqual(6000);
    expect(fields.find((field) => field.name === '프로젝트')?.value).toContain('생략됨');
    expect(fields.find((field) => field.name === 'MCP')?.value).toContain('생략됨');
  });

  it('truncates oversized session IDs to Discord embed field bounds', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1' }, deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: InfoCommandDependencies = {
      stateManager: {
        getSession: vi.fn(() => ({ ...session, sessionId: `session-${'s'.repeat(2000)}` })),
        getQueue: vi.fn(() => []),
      },
      serverManager: { getClient: vi.fn(() => ({ session: { messages: vi.fn(async () => []) } })) },
      cacheManager: { getMcpStatus: vi.fn(() => ({})) },
    };

    await createInfoCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: '/repo' } });

    const replyOptions = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as { embeds?: Array<{ data: { fields?: Array<{ name: string; value: string }> } }> } | undefined;
    const fields = replyOptions?.embeds?.[0]?.data.fields ?? [];
    expect(fields.every((field) => field.value.length <= 1024)).toBe(true);
    expect(fields.find((field) => field.name === '세션')?.value).toContain('생략됨');
  });

  it('includes live stream telemetry when available', async () => {
    const interaction = { channelId: 'thread-1', channel: { parentId: 'channel-1' }, deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const deps: InfoCommandDependencies = {
      stateManager: { getSession: vi.fn(() => session), getQueue: vi.fn(() => []) },
      serverManager: { getClient: vi.fn(() => ({ session: { messages: vi.fn(async () => []) } })) },
      cacheManager: { getMcpStatus: vi.fn(() => ({})) },
      streamStatusProvider: {
        getStatus: vi.fn(() => ({
          threadId: 'thread-1',
          sessionId: 'session-1',
          projectPath: '/repo',
          state: 'retrying',
          failures: 2,
          lastEventAt: 1_000,
          lastErrorAt: 2_000,
        })),
      },
      now: () => 3_000,
    };

    await createInfoCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: '/repo' } });

    const replyOptions = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as { embeds?: Array<{ data: { fields?: Array<{ name: string; value: string }> } }> } | undefined;
    const fields = replyOptions?.embeds?.[0]?.data.fields ?? [];
    const streamField = fields.find((field) => field.name === '스트림');
    expect(streamField?.value).toContain('retrying');
    expect(streamField?.value).toContain('실패: 2');
  });

  it('requires a thread with an attached session', async () => {
    const deps: InfoCommandDependencies = {
      stateManager: { getSession: vi.fn(() => undefined), getQueue: vi.fn(() => []) },
      serverManager: { getClient: vi.fn(() => undefined) },
      cacheManager: { getMcpStatus: vi.fn(() => ({})) },
    };

    await expect(createInfoCommandHandler(deps)({ channelId: 'channel-1', channel: null } as unknown as ChatInputCommandInteraction, {
      correlationId: 'corr-1',
      channelConfig: { channelId: 'channel-1', projectPath: '/repo' },
    })).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND });
  });
});
