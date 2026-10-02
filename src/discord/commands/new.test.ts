import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../config/types.js';
import { ErrorCode } from '../../utils/errors.js';
import { createNewCommandHandler, type NewCommandDependencies } from './new.js';

function createInteraction(options: { channel?: unknown; prompt?: string | null; agent?: string | null; title?: string | null } = {}): ChatInputCommandInteraction {
  return {
    channelId: 'channel-1',
    guildId: 'guild-1',
    user: { id: 'user-1' },
    channel: options.channel ?? { threads: { create: vi.fn(async () => ({ id: 'thread-1', send: vi.fn(), members: { add: vi.fn(async () => undefined) } })) } },
    options: {
      getString: vi.fn((name: string, required?: boolean) => {
        if (name === 'prompt') {
          return options.prompt === undefined ? (required ? 'Build feature' : null) : options.prompt;
        }
        if (name === 'agent') {
          return options.agent ?? null;
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

function createDeps(overrides: Partial<NewCommandDependencies> = {}): NewCommandDependencies {
  return {
    serverManager: { ensureRunning: vi.fn(async () => ({ session: {} })) },
    sessionBridge: {
      createSession: vi.fn(async () => ({
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
      sendPrompt: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

describe('createNewCommandHandler', () => {
  const channelConfig: ChannelConfig = { channelId: 'channel-1', projectPath: '/repo', defaultAgent: 'build' };

  it('creates a thread and session, sends the first prompt, and edits the deferred reply', async () => {
    const thread = { id: 'thread-1', send: vi.fn(async () => undefined), members: { add: vi.fn(async () => undefined) } };
    const channel = { threads: { create: vi.fn(async () => thread) } };
    const deps = createDeps();
    const interaction = createInteraction({ channel, prompt: 'Build feature', title: 'Feature work' });

    await createNewCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(deps.serverManager.ensureRunning).toHaveBeenCalledWith('/repo');
    expect(channel.threads.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Feature work' }));
    expect(deps.sessionBridge.createSession).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      title: 'Feature work',
    }));
    expect(deps.sessionBridge.sendPrompt).toHaveBeenCalledWith('thread-1', expect.objectContaining({ content: 'Build feature', agent: 'build' }));
    expect(thread.send).toHaveBeenCalledWith('> **User prompt:**\n> Build feature');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('thread-1') }));
  });

  it('uses the configured channel model for new sessions and the initial prompt', async () => {
    const thread = { id: 'thread-1', send: vi.fn(async () => undefined), members: { add: vi.fn(async () => undefined) } };
    const channel = { threads: { create: vi.fn(async () => thread) } };
    const deps = createDeps();
    const interaction = createInteraction({ channel, prompt: 'Build feature' });
    const modelChannelConfig: ChannelConfig = { ...channelConfig, model: 'google/gemini-3.5-flash' };

    await createNewCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig: modelChannelConfig });

    expect(deps.sessionBridge.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: 'google/gemini-3.5-flash',
    }));
    expect(deps.sessionBridge.sendPrompt).toHaveBeenCalledWith('thread-1', expect.objectContaining({
      model: 'google/gemini-3.5-flash',
    }));
  });

  it('quotes every line of a multiline initial prompt', async () => {
    const thread = { id: 'thread-1', send: vi.fn(async () => undefined), members: { add: vi.fn(async () => undefined) } };
    const channel = { threads: { create: vi.fn(async () => thread) } };
    const deps = createDeps();
    const interaction = createInteraction({ channel, prompt: 'Build feature\nInclude tests' });

    await createNewCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(thread.send).toHaveBeenCalledWith('> **User prompt:**\n> Build feature\n> Include tests');
  });

  it('adds the command user to the created thread', async () => {
    const thread = { id: 'thread-1', send: vi.fn(async () => undefined), members: { add: vi.fn(async () => undefined) } };
    const channel = { threads: { create: vi.fn(async () => thread) } };
    const deps = createDeps();
    const interaction = createInteraction({ channel });

    await createNewCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(thread.members.add).toHaveBeenCalledWith('user-1');
  });

  it('creates a session and waits for the first thread message when prompt is omitted', async () => {
    const thread = { id: 'thread-1', send: vi.fn(async () => undefined), members: { add: vi.fn(async () => undefined) } };
    const channel = { threads: { create: vi.fn(async () => thread) } };
    const deps = createDeps();
    const interaction = createInteraction({ channel, prompt: null });

    await createNewCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(channel.threads.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'OpenCode 세션' }));
    expect(deps.sessionBridge.createSession).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
      agent: 'build',
      title: 'OpenCode 세션',
    }));
    expect(deps.sessionBridge.sendPrompt).not.toHaveBeenCalled();
    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('이 스레드에 메시지를 보내'));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('thread-1') }));
  });

  it('logs each /new execution boundary', async () => {
    const logger = { info: vi.fn() };
    const deps = createDeps({ logger });
    const interaction = createInteraction();

    await createNewCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(logger.info).toHaveBeenCalledWith('/new started', expect.objectContaining({ correlationId: 'corr-1' }));
    expect(logger.info).toHaveBeenCalledWith('/new reply deferred', expect.objectContaining({ correlationId: 'corr-1' }));
    expect(logger.info).toHaveBeenCalledWith('/new OpenCode server ready', expect.objectContaining({ correlationId: 'corr-1', projectPath: '/repo' }));
    expect(logger.info).toHaveBeenCalledWith('/new completed', expect.objectContaining({ correlationId: 'corr-1', threadId: 'thread-1' }));
  });

  it('defers before resolving the OpenCode server or creating a thread', async () => {
    const events: string[] = [];
    const thread = { id: 'thread-1', send: vi.fn(async () => undefined), members: { add: vi.fn(async () => undefined) } };
    const channel = { threads: { create: vi.fn(async () => { events.push('createThread'); return thread; }) } };
    const deps = createDeps({
      serverManager: { ensureRunning: vi.fn(async () => { events.push('ensureRunning'); return { session: {} }; }) },
    });
    const interaction = createInteraction({ channel });
    vi.mocked(interaction.deferReply).mockImplementation(async () => {
      events.push('deferReply');
      return undefined as unknown as Awaited<ReturnType<ChatInputCommandInteraction['deferReply']>>;
    });

    await createNewCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig });

    expect(events.slice(0, 3)).toEqual(['deferReply', 'ensureRunning', 'createThread']);
  });

  it('defers before validating thread support', async () => {
    const interaction = createInteraction({ channel: {} });
    const deps = createDeps();

    await expect(createNewCommandHandler(deps)(interaction, { correlationId: 'corr-1', channelConfig }))
      .rejects.toMatchObject({ code: ErrorCode.DISCORD_API_ERROR });

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(deps.serverManager.ensureRunning).not.toHaveBeenCalled();
  });

  it('rejects disallowed requested agents before starting OpenCode', async () => {
    const deps = createDeps();
    const interaction = createInteraction({ agent: 'debug' });

    await expect(createNewCommandHandler(deps)(interaction, {
      correlationId: 'corr-1',
      channelConfig: { ...channelConfig, allowedAgents: ['build'] },
    })).rejects.toMatchObject({ code: ErrorCode.AGENT_NOT_ALLOWED });

    expect(deps.serverManager.ensureRunning).not.toHaveBeenCalled();
  });
});
