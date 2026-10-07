import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { createNewCommandHandler } from '../../src/discord/commands/new.js';
import { createConnectCommandHandler } from '../../src/discord/commands/connect.js';
import { handleInteraction } from '../../src/discord/handlers/interactionHandler.js';
import { SessionBridge } from '../../src/opencode/sessionBridge.js';
import { StreamHandler } from '../../src/opencode/streamHandler.js';
import { ErrorCode } from '../../src/utils/errors.js';
import type { BotState, SessionState } from '../../src/state/types.js';

function createStateManager(state: BotState) {
  return {
    getState: vi.fn(() => state),
    getSession: vi.fn((threadId: string) => state.sessions[threadId]),
    setSession: vi.fn((threadId: string, session: SessionState) => {
      state.sessions[threadId] = session;
    }),
  };
}

function createOpenCodeClient() {
  async function* promptStream() {
    yield { directory: '/workspace/project', payload: { type: 'message.part.delta', sessionID: 'session-new', messageID: 'msg-new', partID: 'part-1', field: 'text', delta: 'done', messageRole: 'assistant', part: { id: 'part-1', type: 'text' } } };
  }

  return {
    global: { event: vi.fn(() => promptStream()) },
    session: {
      create: vi.fn(async () => ({ id: 'session-new' })),
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({ id: sessionID })),
      abort: vi.fn(async () => undefined),
      messages: vi
        .fn()
        .mockResolvedValueOnce([
          { info: { id: 'msg-2', role: 'assistant' }, parts: [{ type: 'text', text: 'previous answer' }] },
          { info: { id: 'msg-1', role: 'user' }, parts: [{ type: 'text', text: 'previous prompt' }] },
        ]),
      promptAsync: vi.fn(async () => undefined),
    },
  };
}

function createInteraction(commandName: string, values: Record<string, string | null>) {
  const createdThreads: Array<{ id: string; send: ReturnType<typeof vi.fn>; members: { add: ReturnType<typeof vi.fn> } }> = [];
  const interaction = {
    id: `${commandName}-interaction`,
    commandName,
    channelId: 'channel-1',
    guildId: 'guild-1',
    user: { id: 'user-1' },
    replied: false,
    deferred: false,
    channel: {
      threads: {
        create: vi.fn(async () => {
          const thread = { id: `thread-${createdThreads.length + 1}`, send: vi.fn(async () => ({ edit: vi.fn() })), members: { add: vi.fn(async () => undefined) } };
          createdThreads.push(thread);
          return thread;
        }),
      },
    },
    options: {
      getString: vi.fn((name: string, required?: boolean) => {
        const value = values[name] ?? null;
        if (required && value === null) {
          throw new Error(`missing ${name}`);
        }
        return value;
      }),
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => {
      interaction.replied = true;
    }),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    followUp: vi.fn(async () => undefined),
    isChatInputCommand: vi.fn(() => true),
    isAutocomplete: vi.fn(() => false),
    createdThreads,
  };

  return interaction;
}

describe('session flow integration', () => {
  it('runs /new through command handling into SessionBridge and StreamHandler', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = createStateManager(state);
    const client = createOpenCodeClient();
    const threads = new Map<string, { send(content: string): Promise<{ edit(content: string): Promise<void> }> }>();
    const streamHandler = new StreamHandler({
      getThread: (threadId) => threads.get(threadId),
      questionHandler: { handleQuestionEvent: vi.fn() },
      permissionHandler: { handlePermissionEvent: vi.fn() },
      editThrottleMs: 0,
    });
    const bridge = new SessionBridge({ stateManager, streamSubscriber: streamHandler, now: () => 1000 });
    const interaction = createInteraction('new', { prompt: 'build the feature', title: 'Feature work', agent: null });
    const handler = createNewCommandHandler({ serverManager: { ensureRunning: vi.fn(async () => client) }, sessionBridge: bridge });

    await handler(interaction as never, {
      correlationId: 'corr-1',
      channelConfig: { channelId: 'channel-1', projectPath: '/workspace/project', defaultAgent: 'build', allowAgentSwitch: true, allowedAgents: [], allowedUsers: [], permissions: 'auto', questionTimeout: 300, connectHistoryLimit: 10, autoConnect: false },
    });
    const thread = interaction.createdThreads[0];
    if (thread === undefined) {
      throw new Error('thread was not created');
    }
    threads.set(thread.id, thread as never);
    await streamHandler.subscribe(thread.id, 'session-new', client as never, undefined, '/workspace/project');
    await streamHandler.waitForIdle(thread.id);

    expect(client.session.create).toHaveBeenCalledWith({ title: 'Feature work' });
    expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'session-new', agent: 'build' }));
    expect(state.sessions[thread.id]).toMatchObject({ sessionId: 'session-new', projectPath: '/workspace/project', status: 'active' });
    expect(thread.send).toHaveBeenCalledWith('done');
  });

  it('connects to an existing session, replays history, and deduplicates streamed messages', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = createStateManager(state);
    const client = createOpenCodeClient();
    const streamSubscriber = { subscribe: vi.fn(async () => undefined) };
    const bridge = new SessionBridge({ stateManager, streamSubscriber, now: () => 2000 });
    const thread = { id: 'thread-existing', send: vi.fn(async () => ({ edit: vi.fn() })) };

    await bridge.connectToSession({
      client: client as never,
      threadId: thread.id,
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/workspace/project',
      sessionId: 'session-existing',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      historyLimit: 2,
      thread,
    });

    expect(streamSubscriber.subscribe).toHaveBeenCalledWith(thread.id, 'session-existing', client, expect.any(Set), '/workspace/project');
    expect(client.session.messages).toHaveBeenNthCalledWith(1, { sessionID: 'session-existing', limit: 2 });
    expect(client.session.messages).toHaveBeenCalledTimes(1);
    expect(thread.send).toHaveBeenNthCalledWith(1, 'previous answer');
    expect(thread.send).toHaveBeenNthCalledWith(2, '세션 `session-existing`에 연결했습니다.');
  });

  it('formats permission denied command failures through the interaction boundary', async () => {
    const interaction = createInteraction('connect', { session: 'session-existing', title: null });
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const commandHandlers = new Map([
      ['connect', createConnectCommandHandler({ stateManager: createStateManager(state), serverManager: { ensureRunning: vi.fn() }, sessionBridge: { connectToSession: vi.fn() } })],
    ]);

    await handleInteraction(interaction as never, {
      configLoader: {
        getChannelConfig: vi.fn(() => ({ channelId: 'channel-1', projectPath: '/workspace/project', allowedUsers: ['user-2'], allowAgentSwitch: true, allowedAgents: [], permissions: 'auto', questionTimeout: 300, connectHistoryLimit: 10, autoConnect: false })),
      } as never,
      commandHandlers,
      autocompleteHandler: vi.fn(),
    });

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('요청을 처리하지 못했습니다.'),
      flags: MessageFlags.Ephemeral,
    }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('참조:') }));
  });

  it('formats missing server failures as structured user-visible command errors before creating a thread', async () => {
    const interaction = createInteraction('new', { prompt: 'build the feature', title: 'Feature work', agent: null });
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const commandHandlers = new Map([
      ['new', createNewCommandHandler({
        serverManager: { ensureRunning: vi.fn(async () => undefined) },
        sessionBridge: { createSession: vi.fn(), sendPrompt: vi.fn() },
      })],
    ]);

    await handleInteraction(interaction as never, {
      configLoader: {
        getChannelConfig: vi.fn(() => ({ channelId: 'channel-1', projectPath: '/workspace/project', defaultAgent: 'build', allowAgentSwitch: true, allowedAgents: [], allowedUsers: [], permissions: 'auto', questionTimeout: 300, connectHistoryLimit: 10, autoConnect: false })),
      } as never,
      commandHandlers,
      autocompleteHandler: vi.fn(),
    });

    expect(interaction.channel.threads.create).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('요청을 처리하지 못했습니다.'),
      flags: MessageFlags.Ephemeral,
    }));
    expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('참조:') }));
    expect(state.sessions).toEqual({});
  });

  it('surfaces missing OpenCode session errors before creating an attachment mapping', async () => {
    const state: BotState = { version: 1, servers: {}, sessions: {}, queues: {} };
    const stateManager = createStateManager(state);
    const bridge = new SessionBridge({ stateManager, streamSubscriber: { subscribe: vi.fn() } });
    const client = createOpenCodeClient();
    client.session.get.mockResolvedValueOnce(null);

    await expect(bridge.connectToSession({
      client: client as never,
      threadId: 'thread-missing',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/workspace/project',
      sessionId: 'missing-session',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      thread: { send: vi.fn() },
    })).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND });

    expect(state.sessions['thread-missing']).toBeUndefined();
  });
});
