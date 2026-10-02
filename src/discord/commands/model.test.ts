import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import type { SessionState } from '../../state/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createModelCommandHandler, type ModelCommandDependencies } from './model.js';

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

function createInteraction(subcommand: string, model = 'anthropic/claude'): ChatInputCommandInteraction {
  return {
    channelId: 'thread-1',
    guildId: 'guild-1',
    channel: { parentId: 'channel-1' },
    options: { getSubcommand: vi.fn(() => subcommand), getString: vi.fn(() => model) },
    reply: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
}

function createDeps(models: unknown[] = [{ id: 'anthropic', models: [{ id: 'claude' }, { id: 'haiku' }] }]): ModelCommandDependencies {
  return {
    stateManager: { getSession: vi.fn(() => session), setSession: vi.fn() },
    serverManager: { ensureRunning: vi.fn(async () => ({ config: {} })) },
    cacheManager: { refresh: vi.fn(async () => undefined), getModels: vi.fn(() => models) },
  };
}

describe('createModelCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo' };

  it('validates the model against cache and updates thread-local state', async () => {
    const deps = createDeps();

    await createModelCommandHandler(deps)(createInteraction('set'), { correlationId: 'corr-1', channelConfig });

    expect(deps.serverManager.ensureRunning).toHaveBeenCalledWith('/repo');
    expect(deps.stateManager.setSession).toHaveBeenCalledWith('thread-1', { ...session, model: 'anthropic/claude' });
  });

  it('validates models from object-mapped provider metadata', async () => {
    const deps = createDeps([{ id: 'github-copilot', models: { 'gpt-5.5': { id: 'gpt-5.5' } } }]);

    await createModelCommandHandler(deps)(createInteraction('set', 'github-copilot/gpt-5.5'), { correlationId: 'corr-1', channelConfig });

    expect(deps.stateManager.setSession).toHaveBeenCalledWith('thread-1', { ...session, model: 'github-copilot/gpt-5.5' });
  });

  it('defers model set before starting server/cache validation work', async () => {
    const events: string[] = [];
    const deps = createDeps();
    vi.mocked(deps.serverManager.ensureRunning).mockImplementation(async () => { events.push('ensureRunning'); return { config: {} }; });
    vi.mocked(deps.cacheManager.refresh).mockImplementation(async () => { events.push('refresh'); });
    const interaction = createInteraction('set');
    vi.mocked(interaction.deferReply).mockImplementation(async () => { events.push('deferReply'); return {} as Awaited<ReturnType<ChatInputCommandInteraction['deferReply']>>; });

    await createModelCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(events).toEqual(['deferReply', 'ensureRunning', 'refresh']);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('모델을') }));
  });

  it('rejects unknown models', async () => {
    const deps = createDeps();

    await expect(createModelCommandHandler(deps)(createInteraction('set', 'openai/gpt'), { correlationId: 'corr-1', channelConfig })).rejects.toMatchObject({
      code: ErrorCode.MODEL_NOT_FOUND,
    });
  });

  it('lists models grouped by provider', async () => {
    const deps = createDeps();
    const interaction = createInteraction('list');

    await createModelCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ title: '사용 가능한 모델' }) })] }));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ fields: expect.arrayContaining([expect.objectContaining({ name: 'anthropic' })]) }) })] }));
  });

  it('lists models from object-mapped provider metadata', async () => {
    const deps = createDeps([{ id: 'github-copilot', models: { 'gpt-5.5': { id: 'gpt-5.5' } } }]);
    const interaction = createInteraction('list');

    await createModelCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ fields: expect.arrayContaining([expect.objectContaining({ value: expect.stringContaining('github-copilot/gpt-5.5') })]) }) })] }));
  });

  it('defers model list before starting server/cache work', async () => {
    const events: string[] = [];
    const deps = createDeps();
    vi.mocked(deps.serverManager.ensureRunning).mockImplementation(async () => { events.push('ensureRunning'); return { config: {} }; });
    vi.mocked(deps.cacheManager.refresh).mockImplementation(async () => { events.push('refresh'); });
    const interaction = createInteraction('list');
    vi.mocked(interaction.deferReply).mockImplementation(async () => { events.push('deferReply'); return {} as Awaited<ReturnType<ChatInputCommandInteraction['deferReply']>>; });

    await createModelCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(events).toEqual(['deferReply', 'ensureRunning', 'refresh']);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('truncates large provider and model lists to fit Discord embed limits', async () => {
    const models = Array.from({ length: 40 }, (_, providerIndex) => ({
      id: `provider-${providerIndex}-${'p'.repeat(120)}`,
      models: Array.from({ length: 80 }, (_, modelIndex) => ({ id: `model-${modelIndex}-${'m'.repeat(80)}` })),
    }));
    const deps = createDeps(models);
    const interaction = createInteraction('list');

    await createModelCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const replyOptions = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as { embeds?: Array<{ data: { title?: string; description?: string; fields?: Array<{ name: string; value: string }> } }> } | undefined;
    const embed = replyOptions?.embeds?.[0];
    const totalLength = (embed?.data.title?.length ?? 0)
      + (embed?.data.description?.length ?? 0)
      + (embed?.data.fields ?? []).reduce<number>((total, field) => total + field.name.length + field.value.length, 0);
    expect(embed?.data.fields?.length ?? 0).toBeLessThanOrEqual(25);
    expect(totalLength).toBeLessThanOrEqual(6000);
    expect(JSON.stringify(embed?.data)).toContain('생략');
  });

  it('keeps total embed text within 6000 when provider count truncation adds a marker', async () => {
    const modelId = 'm'.repeat(214);
    const models = Array.from({ length: 26 }, (_, providerIndex) => ({
      id: `provider-${String(providerIndex).padStart(2, '0')}`,
      models: [{ id: modelId }],
    }));
    const deps = createDeps(models);
    const interaction = createInteraction('list');

    await createModelCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    const replyOptions = vi.mocked(interaction.editReply).mock.calls[0]?.[0] as { embeds?: Array<{ data: { title?: string; description?: string; fields?: Array<{ name: string; value: string }> } }> } | undefined;
    const embed = replyOptions?.embeds?.[0];
    const totalLength = (embed?.data.title?.length ?? 0)
      + (embed?.data.description?.length ?? 0)
      + (embed?.data.fields ?? []).reduce<number>((total, field) => total + field.name.length + field.value.length, 0);
    expect(embed?.data.fields?.length ?? 0).toBeLessThanOrEqual(25);
    expect(totalLength).toBeLessThanOrEqual(6000);
    expect(JSON.stringify(embed?.data)).toContain('생략');
  });
});
