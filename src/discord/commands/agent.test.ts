import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import type { SessionState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createAgentCommandHandler, type AgentCommandDependencies } from './agent.js';

const session: SessionState = {
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
};

function createInteraction(subcommand: string, agent = 'debug'): ChatInputCommandInteraction {
  return {
    channelId: 'thread-1',
    guildId: 'guild-1',
    channel: { parentId: 'channel-1' },
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn(() => agent),
    },
    reply: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(overrides: Partial<AgentCommandDependencies> = {}): AgentCommandDependencies {
  return {
    stateManager: { getSession: vi.fn(() => session), setSession: vi.fn() },
    serverManager: { ensureRunning: vi.fn(async () => ({ app: {} })) },
    cacheManager: { refresh: vi.fn(async () => undefined), getAgents: vi.fn(() => [{ name: 'build' }, { id: 'debug' }, { name: 'review' }]) },
    ...overrides,
  };
}

describe('createAgentCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo', allowAgentSwitch: true, allowedAgents: ['build', 'debug'] };

  it('switches the OpenCode agent before updating the local session', async () => {
    const switchAgent = vi.fn(async () => ({ data: { agent: 'debug' } }));
    const deps = createDeps({ serverManager: { ensureRunning: vi.fn(async () => ({ v2Root: { session: { switchAgent } } })) } });

    await createAgentCommandHandler(deps)(createInteraction('set', 'debug'), { correlationId: 'corr-1', channelConfig });

    expect(switchAgent).toHaveBeenCalledWith({ sessionID: 'session-1', agent: 'debug' });
    expect(switchAgent).toHaveBeenCalledBefore(deps.stateManager.setSession as never);
    expect(deps.stateManager.setSession).toHaveBeenCalledWith('thread-1', { ...session, agent: 'debug' });
  });

  it('does not claim an agent switch when OpenCode rejects it', async () => {
    const deps = createDeps({ serverManager: { ensureRunning: vi.fn(async () => ({ v2Root: { session: { switchAgent: vi.fn(async () => ({ error: 'unavailable' })) } } })) } });

    await expect(createAgentCommandHandler(deps)(createInteraction('set', 'debug'), { correlationId: 'corr-1', channelConfig }))
      .rejects.toMatchObject({ code: ErrorCode.SERVER_UNHEALTHY });
    expect(deps.stateManager.setSession).not.toHaveBeenCalled();
  });

  it('rejects agent set when switching is disabled', async () => {
    const deps = createDeps();

    await expect(createAgentCommandHandler(deps)(createInteraction('set', 'debug'), {
      correlationId: 'corr-1',
      channelConfig: { ...channelConfig, allowAgentSwitch: false },
    })).rejects.toMatchObject({ code: ErrorCode.AGENT_SWITCH_DISABLED });
  });

  it('lists cached agents filtered by allowedAgents', async () => {
    const deps = createDeps();
    const interaction = createInteraction('list');

    await createAgentCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(deps.serverManager.ensureRunning).toHaveBeenCalledWith('/repo');
    expect(deps.cacheManager.refresh).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ title: '사용 가능한 에이전트' }) })] }));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ description: expect.stringContaining('debug') }) })] }));
    expect(interaction.editReply).not.toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ description: expect.stringContaining('review') }) })] }));
  });

  it('lists only direct-use agents', async () => {
    const deps = createDeps({
      cacheManager: {
        refresh: vi.fn(async () => undefined),
        getAgents: vi.fn(() => [
          { name: 'build', mode: 'primary' },
          { name: 'plan', mode: 'primary' },
          { name: 'custom' },
          { name: 'general', mode: 'subagent' },
          { name: 'compact', mode: 'primary', hidden: true },
        ]),
      },
    });
    const interaction = createInteraction('list');

    await createAgentCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: '/repo' } });

    const replyOptions = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as { embeds?: Array<{ data: { description?: string } }> } | undefined;
    const description = replyOptions?.embeds?.[0]?.data.description ?? '';
    expect(description).toContain('build');
    expect(description).toContain('plan');
    expect(description).toContain('custom');
    expect(description).not.toContain('general');
    expect(description).not.toContain('compact');
  });

  it('defers the list reply before starting server/cache work', async () => {
    const events: string[] = [];
    const deps = createDeps({
      serverManager: { ensureRunning: vi.fn(async () => { events.push('ensureRunning'); return { app: {} }; }) },
      cacheManager: { refresh: vi.fn(async () => { events.push('refresh'); }), getAgents: vi.fn(() => []) },
    });
    const interaction = createInteraction('list');
    vi.mocked(interaction.deferReply).mockImplementation(async () => { events.push('deferReply'); return {} as Awaited<ReturnType<ChatInputCommandInteraction['deferReply']>>; });

    await createAgentCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(events).toEqual(['deferReply', 'ensureRunning', 'refresh']);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('truncates large agent lists to fit Discord embed limits', async () => {
    const agents = Array.from({ length: 400 }, (_, index) => ({ name: `agent-${index}-${'x'.repeat(30)}` }));
    const deps = createDeps({
      cacheManager: { refresh: vi.fn(async () => undefined), getAgents: vi.fn(() => agents) },
    });
    const interaction = createInteraction('list');

    await createAgentCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: { channelId: 'channel-1', projectPath: '/repo' } });

    const replyOptions = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as { embeds?: Array<{ data: { description?: string } }> } | undefined;
    const embed = replyOptions?.embeds?.[0];
    const description = embed?.data.description ?? '';
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(description).toContain('생략됨');
  });
});
