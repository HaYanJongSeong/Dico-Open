import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../utils/errors.js';
import { SessionBridge } from './sessionBridge.js';
import type { OpencodeSessionClient, StreamSubscriber } from './sessionBridge.js';
import type { SessionState } from '../state/types.js';

interface StateManagerStub {
  sessions: Map<string, SessionState>;
  getSession: ReturnType<typeof vi.fn<(threadId: string) => SessionState | undefined>>;
  setSession: ReturnType<typeof vi.fn<(threadId: string, session: SessionState) => void>>;
}

function createStateManager(): StateManagerStub {
  const sessions = new Map<string, SessionState>();

  return {
    sessions,
    getSession: vi.fn((threadId: string) => sessions.get(threadId)),
    setSession: vi.fn((threadId: string, session: SessionState) => {
      sessions.set(threadId, session);
    }),
  };
}

function createClient(overrides: Partial<OpencodeSessionClient['session']> = {}): OpencodeSessionClient {
  return {
    session: {
      create: vi.fn(async () => ({ id: 'session-1' })),
      get: vi.fn(async () => ({ id: 'session-1' })),
      abort: vi.fn(async () => undefined),
      messages: vi.fn(async () => []),
      promptAsync: vi.fn(async () => undefined),
      ...overrides,
    },
  };
}

function createBridge(now = 1000): { bridge: SessionBridge; stateManager: StateManagerStub; streamSubscriber: StreamSubscriber } {
  const stateManager = createStateManager();
  const streamSubscriber: StreamSubscriber = {
    subscribe: vi.fn(async () => undefined),
    refreshTypingForThread: vi.fn(),
    stopTypingForThread: vi.fn(),
  };

  return {
    bridge: new SessionBridge({ stateManager, streamSubscriber, now: () => now }),
    stateManager,
    streamSubscriber,
  };
}

describe('SessionBridge', () => {
  it('creates an SDK session, persists the thread mapping, and returns session state', async () => {
    const { bridge, stateManager } = createBridge(1234);
    const client = createClient({ create: vi.fn(async () => ({ data: { sessionID: 'session-123' } })) });

    const session = await bridge.createSession({
      client,
      threadId: 'thread-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: 'anthropic/claude',
      createdBy: 'user-1',
      title: 'Task thread',
    });

    expect(client.session.create).toHaveBeenCalledWith({ title: 'Task thread' });
    expect(session).toEqual({
      sessionId: 'session-123',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: 'anthropic/claude',
      createdBy: 'user-1',
      createdAt: 1234,
      lastActivityAt: 1234,
      userMirrorSince: 1234,
      status: 'active',
    });
    expect(stateManager.setSession).toHaveBeenCalledWith('thread-1', session);
  });

  it('unwraps the nested CLI v2 session create response', async () => {
    const { bridge } = createBridge(1234);
    const client = createClient({ create: vi.fn(async () => ({ data: { data: { id: 'session-v2' } } })) as never });

    const session = await bridge.createSession({
      client,
      threadId: 'thread-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      title: 'Task thread',
    });

    expect(session.sessionId).toBe('session-v2');
  });

  it('sets the selected agent on a new CLI v2 session before storing the mapping', async () => {
    const { bridge, stateManager } = createBridge();
    const switchAgent = vi.fn(async () => ({ data: { agent: 'plan' } }));
    const client = { ...createClient(), v2Root: { session: { switchAgent } } } as unknown as OpencodeSessionClient;

    await bridge.createSession({ client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo', agent: 'plan', createdBy: 'user-1' });

    expect(switchAgent).toHaveBeenCalledWith({ sessionID: 'session-1', agent: 'plan' });
    expect(switchAgent).toHaveBeenCalledBefore(stateManager.setSession);
  });

  it('does not persist a new session when OpenCode rejects the selected agent', async () => {
    const { bridge, stateManager } = createBridge();
    const client = { ...createClient(), v2Root: { session: { switchAgent: vi.fn(async () => ({ error: 'unavailable' })) } } } as unknown as OpencodeSessionClient;

    await expect(bridge.createSession({ client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo', agent: 'plan', createdBy: 'user-1' }))
      .rejects.toMatchObject({ code: ErrorCode.SERVER_UNHEALTHY });
    expect(stateManager.setSession).not.toHaveBeenCalled();
  });

  it('subscribes newly created sessions after persisting the thread mapping', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge(1234);
    const client = createClient({ create: vi.fn(async () => ({ data: { sessionID: 'session-123' } })) });
    const calls: string[] = [];
    stateManager.setSession.mockImplementation((threadId: string, session: SessionState) => {
      calls.push(`set:${threadId}:${session.sessionId}`);
      stateManager.sessions.set(threadId, session);
    });
    vi.mocked(streamSubscriber.subscribe).mockImplementation(async (threadId: string, sessionId: string) => {
      calls.push(`subscribe:${threadId}:${sessionId}`);
    });

    await bridge.createSession({
      client,
      threadId: 'thread-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      title: 'Task thread',
    });

    expect(streamSubscriber.subscribe).toHaveBeenCalledWith('thread-1', 'session-123', client, expect.any(Set));
    expect(calls).toEqual(['set:thread-1:session-123', 'subscribe:thread-1:session-123']);
  });

  it('builds text and file prompt parts, parses model, and updates activity time', async () => {
    const { bridge, stateManager } = createBridge(2000);
    const client = createClient();
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: 'anthropic/claude',
      createdBy: 'user-1',
      createdAt: 1000,
      lastActivityAt: 1000,
      status: 'active',
    });

    await bridge.sendPrompt('thread-1', {
      client,
      content: 'Summarize this',
      files: [{ url: 'https://cdn.example/file.txt', mime: 'text/plain', filename: 'file.txt' }],
    });

    expect(client.session.promptAsync).toHaveBeenCalledWith({
      sessionID: 'session-1',
      parts: [
        { type: 'text', text: 'Summarize this' },
        { type: 'file', mime: 'text/plain', url: 'https://cdn.example/file.txt', filename: 'file.txt' },
      ],
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude' },
    });
    expect(stateManager.setSession).toHaveBeenCalledWith('thread-1', {
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
    });
  });

  it('refreshes the stream subscription with the active client before sending each prompt', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge(2000);
    const client = createClient();
    stateManager.sessions.set('thread-1', {
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
    });

    await bridge.sendPrompt('thread-1', { client, content: 'after restart' });

    expect(streamSubscriber.subscribe).toHaveBeenCalledWith('thread-1', 'session-1', client, expect.any(Set));
    expect(streamSubscriber.subscribe).toHaveBeenCalledBefore(client.session.promptAsync as never);
  });

  it('starts Discord typing after OpenCode accepts the prompt', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge(2000);
    const startTypingForThread = vi.fn();
    Object.assign(streamSubscriber, { startTypingForThread });
    stateManager.sessions.set('thread-1', {
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
    });

    await bridge.sendPrompt('thread-1', { client: createClient(), content: 'hello' });

    expect(startTypingForThread).toHaveBeenCalledWith('thread-1');
  });

  it('verifies the OpenCode session before sending a prompt', async () => {
    const { bridge, stateManager } = createBridge(2000);
    const client = createClient();
    stateManager.sessions.set('thread-1', {
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
    });

    await bridge.sendPrompt('thread-1', { client, content: 'after reboot' });

    expect(client.session.get).toHaveBeenCalledWith({ sessionID: 'session-1' });
    expect(client.session.get).toHaveBeenCalledBefore(client.session.promptAsync as never);
  });

  it('throws SESSION_NOT_FOUND and does not prompt when OpenCode lost the persisted session', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge(2000);
    const client = createClient({ get: vi.fn(async () => null) });
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
    stateManager.sessions.set('thread-1', session);

    await expect(bridge.sendPrompt('thread-1', { client, content: 'after reboot' })).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    });

    expect(streamSubscriber.subscribe).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(stateManager.setSession).not.toHaveBeenCalled();
  });

  it('refreshes the stream subscription before every prompt with the same client', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge(2000);
    const client = createClient();
    stateManager.sessions.set('thread-1', {
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
    });

    await bridge.sendPrompt('thread-1', { client, content: 'first prompt' });
    await bridge.sendPrompt('thread-1', { client, content: 'after archived idle' });

    expect(streamSubscriber.subscribe).toHaveBeenCalledTimes(2);
    expect(streamSubscriber.subscribe).toHaveBeenNthCalledWith(1, 'thread-1', 'session-1', client, expect.any(Set));
    expect(streamSubscriber.subscribe).toHaveBeenNthCalledWith(2, 'thread-1', 'session-1', client, expect.any(Set));
  });

  it('connects to an existing session, replays history, subscribes streams, and recovers gaps', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge(3000);
    const client = createClient({
      messages: vi
        .fn()
        .mockResolvedValueOnce({
          data: [
            { info: { id: 'msg-2', role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] },
            { info: { id: 'msg-1', role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
          ],
        })
        .mockResolvedValueOnce([
          { info: { id: 'msg-1', role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
          { info: { id: 'msg-3', role: 'assistant' }, parts: [{ type: 'text', text: 'new answer' }] },
        ]),
    });
    const thread = { send: vi.fn(async () => undefined) };

    await bridge.connectToSession({
      client,
      threadId: 'thread-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      sessionId: 'session-1',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      historyLimit: 2,
      thread,
    });

    expect(client.session.get).toHaveBeenCalledWith({ sessionID: 'session-1' });
    expect(stateManager.setSession).toHaveBeenCalledWith('thread-1', {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 3000,
      lastActivityAt: 3000,
      userMirrorSince: 3000,
      status: 'active',
    });
    expect(streamSubscriber.subscribe).toHaveBeenCalledWith('thread-1', 'session-1', client, expect.any(Set));
    expect(client.session.messages).toHaveBeenNthCalledWith(1, { sessionID: 'session-1', limit: 2 });
    expect(thread.send).toHaveBeenNthCalledWith(1, 'done');
    expect(thread.send).toHaveBeenNthCalledWith(2, '세션 `session-1`에 연결했습니다.');
  });

  it('rejects failed or mismatched session lookups before attaching a thread', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    for (const [response, code] of [
      [{ error: { message: 'missing' } }, ErrorCode.SERVER_UNHEALTHY],
      [{ data: { data: { id: 'wrong-session' } } }, ErrorCode.SESSION_NOT_FOUND],
    ] as const) {
      const client = createClient({ get: vi.fn(async () => response) as never });
      await expect(bridge.connectToSession({
        client, thread, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1',
        projectPath: '/repo', sessionId: 'session-1', agent: 'build', createdBy: 'user-1',
      })).rejects.toMatchObject({ code });
    }

    expect(stateManager.setSession).not.toHaveBeenCalled();
    expect(streamSubscriber.subscribe).not.toHaveBeenCalled();
    expect(thread.send).not.toHaveBeenCalled();
  });

  it('distinguishes a confirmed missing session from a temporary lookup failure', async () => {
    const { bridge, stateManager } = createBridge();
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000, status: 'active',
    });

    await expect(bridge.sendPrompt('thread-1', {
      client: createClient({ get: vi.fn(async () => ({ response: { status: 404 }, error: 'missing' })) as never }), content: 'check',
    })).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND, context: { status: 404 } });

    await expect(bridge.sendPrompt('thread-1', {
      client: createClient({ get: vi.fn(async () => ({ response: { status: 503 }, error: 'offline' })) as never }), content: 'check',
    })).rejects.toMatchObject({ code: ErrorCode.SERVER_UNHEALTHY });
    await expect(bridge.sendPrompt('thread-1', {
      client: createClient({ get: vi.fn(async () => { throw new Error('offline'); }) }), content: 'check',
    })).rejects.toMatchObject({ code: ErrorCode.SERVER_UNHEALTHY });
  });

  it('continues connecting when history replay fails', async () => {
    const { bridge, streamSubscriber } = createBridge(3000);
    const client = createClient({
      messages: vi.fn().mockRejectedValueOnce(new Error('history unavailable')).mockResolvedValueOnce([]),
    });
    const thread = { send: vi.fn(async () => undefined) };

    await bridge.connectToSession({
      client,
      threadId: 'thread-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      sessionId: 'session-1',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      historyLimit: 10,
      thread,
    });

    expect(streamSubscriber.subscribe).toHaveBeenCalledWith('thread-1', 'session-1', client, expect.any(Set));
    expect(thread.send).toHaveBeenCalledWith('세션 `session-1`에 연결했습니다.');
  });

  it('shares streamed message IDs with periodic history replay', async () => {
    const { bridge, stateManager } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'user-1', status: 'active',
    });
    bridge.getDedupeSet('thread-1').add('assistant-1');
    const client = createClient({ messages: vi.fn(async () => ({ data: [
      { id: 'assistant-1', type: 'assistant', content: [{ type: 'text', text: 'already streamed' }] },
      { id: 'user-1', type: 'user', content: [{ type: 'text', text: 'question' }] },
    ] })) });

    await bridge.replaySessionHistory({
      client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    });

    expect(thread.send).not.toHaveBeenCalled();
  });

  it('skips whitespace-only assistant history and advances the cursor past it', async () => {
    const { bridge, stateManager } = createBridge();
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'assistant-old', lastSyncedMessageContent: 'old', status: 'active',
    });
    const send = vi.fn(async (content: string) => {
      if (!content.trim()) throw new Error('Cannot send an empty message');
    });
    const client = createClient({ messages: vi.fn(async () => ({ data: [
      { id: 'assistant-new', type: 'assistant', content: [{ type: 'text', text: '새 답변' }] },
      { id: 'assistant-blank', type: 'assistant', content: [{ type: 'reasoning', text: '\n\n' }] },
      { id: 'assistant-old', type: 'assistant', content: [{ type: 'text', text: 'old' }] },
    ] })) });
    const options = {
      client, thread: { send }, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1',
      projectPath: '/repo', sessionId: 'session-1', agent: 'build', createdBy: 'user-1',
    };

    await bridge.replaySessionHistory(options);
    await bridge.replaySessionHistory(options);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('새 답변');
    expect(stateManager.sessions.get('thread-1')?.lastSyncedMessageId).toBe('assistant-new');
  });

  it('mirrors only future OpenCode user messages in order, never Discord-origin or old messages', async () => {
    const { bridge, stateManager } = createBridge(2000);
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'assistant-old', lastSyncedMessageContent: 'old', status: 'active',
    });
    const messages = vi.fn(async () => ({ data: { data: [
      { id: 'assistant-new', type: 'assistant', content: [{ type: 'text', text: '응답' }] },
      { id: 'user-discord', type: 'user', time: { created: 2003 }, text: '이미 Discord에 있음', metadata: { opencodeDiscordOrigin: true } },
      { id: 'user-new', type: 'user', time: { created: 2002 }, text: '@everyone 새 질문' },
      { id: 'user-old', type: 'user', time: { created: 1999 }, text: '예전 질문' },
      { id: 'assistant-old', type: 'assistant', content: [{ type: 'text', text: 'old' }] },
    ] } }));
    const options = {
      client: createClient({ messages }), threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1',
      projectPath: '/repo', sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    };
    await bridge.replaySessionHistory(options);
    expect(thread.send).toHaveBeenCalledTimes(2);
    expect(thread.send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      content: '**나:**\n> @everyone 새 질문', allowedMentions: { parse: [] },
    }));
    expect(thread.send).toHaveBeenNthCalledWith(2, '응답');
    expect(stateManager.sessions.get('thread-1')?.userMirrorSince).toBe(2000);
    await bridge.replaySessionHistory(options);
    expect(thread.send).toHaveBeenCalledTimes(2);
  });

  it('keeps the forward-only cutoff on restart and retries a failed user delivery', async () => {
    const { bridge, stateManager } = createBridge(2000);
    const session: SessionState = {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'assistant-old', lastSyncedMessageContent: 'old', status: 'active',
    };
    stateManager.sessions.set('thread-1', session);
    const messages = vi.fn(async (): Promise<unknown> => ({ data: [
      { id: 'assistant-old', type: 'assistant', content: [{ type: 'text', text: 'old' }] },
    ] }));
    const options = {
      client: createClient({ messages }), threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1',
      projectPath: '/repo', sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1',
      thread: { send: vi.fn().mockRejectedValueOnce(new Error('Discord unavailable')).mockResolvedValue(undefined) },
    };
    await bridge.replaySessionHistory(options);
    expect(stateManager.sessions.get('thread-1')?.userMirrorSince).toBe(2000);
    messages.mockResolvedValue({ data: [
      { id: 'user-new', type: 'user', time: { created: 2001 }, text: '재시작 후에도 전송' },
      { id: 'assistant-old', type: 'assistant', content: [{ type: 'text', text: 'old' }] },
    ] });
    const restarted = new SessionBridge({ stateManager, streamSubscriber: { subscribe: vi.fn() }, now: () => 5000 });
    await expect(restarted.replaySessionHistory(options)).rejects.toThrow('Discord unavailable');
    expect(stateManager.sessions.get('thread-1')?.lastSyncedMessageId).toBe('assistant-old');
    expect(stateManager.sessions.get('thread-1')?.lastSyncedUserMessageId).toBeUndefined();
    await restarted.replaySessionHistory(options);
    expect(options.thread.send).toHaveBeenCalledTimes(2);
    expect(stateManager.sessions.get('thread-1')?.lastSyncedMessageId).toBe('user-new');
    expect(stateManager.sessions.get('thread-1')?.lastSyncedUserMessageId).toBe('user-new');
    expect(stateManager.sessions.get('thread-1')?.userMirrorSince).toBe(2000);
  });

  it('tags Discord prompts so they cannot echo back to the thread', async () => {
    const { bridge, stateManager } = createBridge();
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000, status: 'active',
    });
    const prompt = vi.fn(async () => ({ data: { id: 'msg-discord' } }));
    const client = { ...createClient(), v2Root: { session: { prompt, switchAgent: vi.fn(async () => undefined), switchModel: vi.fn(async () => undefined), messages: vi.fn() } } };
    await bridge.sendPrompt('thread-1', { client, content: 'Discord에서 보냄' });
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'session-1', text: 'Discord에서 보냄', metadata: { opencodeDiscordOrigin: true },
    }));
  });

  it('does not send a v2 prompt if the selected model switch fails', async () => {
    const { bridge, stateManager } = createBridge();
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: 'anthropic/claude', createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000, status: 'active',
    });
    const prompt = vi.fn(async () => undefined);
    const switchModel = vi.fn(async () => ({ error: 'unavailable' }));
    const client = { ...createClient(), v2Root: { session: { prompt, switchModel } } } as unknown as OpencodeSessionClient;

    await expect(bridge.sendPrompt('thread-1', { client, content: 'model check' }))
      .rejects.toMatchObject({ code: ErrorCode.SERVER_UNHEALTHY });
    expect(switchModel).toHaveBeenCalledWith({ sessionID: 'session-1', model: { providerID: 'anthropic', id: 'claude' } });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('forwards only new image tool results and retries failed Discord uploads without duplicates', async () => {
    const stateManager = createStateManager();
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1, lastActivityAt: 1,
      lastSyncedMessageId: 'msg-new', lastSyncedMessageContent: 'already synced', status: 'active',
    });
    const file = { type: 'file', uri: image, mime: 'image/png', name: 'image.png' };
    const tool = (id: string, content: Array<{ type: string; uri: string; mime: string; name?: string }> = [file], completed = 1001) => ({ type: 'tool', id, time: { completed }, state: { status: 'completed', content } });
    const client = createClient({ messages: vi.fn(async () => [
      { id: 'msg-new', type: 'assistant', time: { created: 999 }, content: [{ type: 'text', text: 'already synced' }, tool('part-new', [file, file, { type: 'file', uri: 'file:///private/image.png', mime: 'image/png' }, { type: 'file', uri: 'data:image/svg+xml;base64,PHN2Zz4=', mime: 'image/svg+xml' }])] },
      { id: 'msg-old', type: 'assistant', time: { created: 999 }, content: [tool('part-old', [{ type: 'file', uri: 'data:image/png;base64,aGVsbG8=', mime: 'image/png' }], 999)] },
    ]) });
    const thread = { send: vi.fn().mockRejectedValueOnce(new Error('Discord unavailable')).mockResolvedValue(undefined) };
    const options = { client, thread, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo', sessionId: 'session-1', agent: 'build', createdBy: 'user-1' };
    const bridge = new SessionBridge({ stateManager, streamSubscriber: { subscribe: vi.fn() }, now: () => 1000, syncImages: true } as never);

    await expect(bridge.replaySessionHistory(options)).rejects.toThrow('Discord unavailable');
    expect(stateManager.sessions.get('thread-1')?.syncedImageHashes).toBeUndefined();
    await bridge.replaySessionHistory(options);
    expect(thread.send).toHaveBeenCalledTimes(2);
    const upload = vi.mocked(thread.send).mock.calls[1]?.[0] as { content: string; files: Array<{ attachment: Buffer }> };
    expect(upload.content).toBe('');
    expect(upload.files[0]?.attachment).toEqual(Buffer.from(image.split(',')[1]!, 'base64'));
    expect(stateManager.sessions.get('thread-1')?.syncedImageHashes).toHaveLength(1);
    expect(stateManager.sessions.get('thread-1')?.imageMirrorSince).toBe(1000);

    await new SessionBridge({ stateManager, streamSubscriber: { subscribe: vi.fn() }, now: () => 2000, syncImages: true } as never).replaySessionHistory(options);
    expect(thread.send).toHaveBeenCalledTimes(2);
  });

  it('does not echo a legacy Discord attachment prompt without source metadata', async () => {
    const { bridge, stateManager } = createBridge(1000);
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 500, lastActivityAt: 500,
      lastSyncedMessageId: 'assistant-old', lastSyncedMessageContent: 'old', userMirrorSince: 1000, status: 'active',
    });
    const fetch = vi.fn(async () => new Map([['discord-1', {
      author: { bot: false }, content: '첨부한 질문', createdTimestamp: 1050,
    }]]));
    const thread = { send: vi.fn(async () => undefined), messages: { fetch } };
    await bridge.replaySessionHistory({
      client: createClient({ messages: vi.fn(async () => ({ data: [
        { id: 'user-direct', type: 'user', time: { created: 72_000 }, text: '다른 질문' },
        { id: 'user-discord', type: 'user', time: { created: 1100 }, text: '첨부한 질문' },
        { id: 'assistant-old', type: 'assistant', content: [{ type: 'text', text: 'old' }] },
      ] })) }),
      threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    });
    expect(fetch).toHaveBeenCalledWith({ limit: 100 });
    expect(thread.send).toHaveBeenCalledOnce();
    expect(thread.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('다른 질문') }));
  });

  it('recovers an unmirrored user message even when the assistant marker has passed it', async () => {
    const { bridge, stateManager } = createBridge(1000);
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 500, lastActivityAt: 500,
      lastSyncedMessageId: 'assistant-after', lastSyncedMessageContent: '답변', userMirrorSince: 1000, status: 'active',
    });
    bridge.getDedupeSet('thread-1').add('user-missed');
    const thread = { send: vi.fn(async () => undefined) };
    const options = {
      client: createClient({ messages: vi.fn(async () => ({ data: [
        { id: 'assistant-after', type: 'assistant', content: [{ type: 'text', text: '답변' }] },
        { id: 'user-missed', type: 'user', time: { created: 2000 }, text: '누락된 내 말' },
      ] })) }),
      threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    };
    await bridge.replaySessionHistory(options);
    expect(thread.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('누락된 내 말') }));
    expect(stateManager.sessions.get('thread-1')?.lastSyncedUserMessageId).toBe('user-missed');
    await new SessionBridge({ stateManager, streamSubscriber: { subscribe: vi.fn() }, now: () => 4000 }).replaySessionHistory(options);
    expect(thread.send).toHaveBeenCalledOnce();
  });

  it('checks the recent 100 when a user turn fell out of the normal 5-message window', async () => {
    const { bridge, stateManager } = createBridge(1000);
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 500, lastActivityAt: 500,
      lastSyncedMessageId: 'assistant-after', lastSyncedMessageContent: '답변', userMirrorSince: 1000, status: 'active',
    });
    const messages = vi.fn(async ({ limit }: { limit?: number }) => ({ data: limit === 100
      ? [
          { id: 'assistant-after', type: 'assistant', content: [{ type: 'text', text: '답변' }] },
          { id: 'user-missed', type: 'user', time: { created: 2000 }, text: '창 밖 내 말' },
        ]
      : [{ id: 'assistant-after', type: 'assistant', content: [{ type: 'text', text: '답변' }] }],
    }));
    const thread = { send: vi.fn(async () => undefined) };
    await bridge.replaySessionHistory({
      client: createClient({ messages }), threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1',
      projectPath: '/repo', sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
      historyLimit: 5,
    });
    expect(messages).toHaveBeenCalledWith({ sessionID: 'session-1', limit: 100 });
    expect(thread.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('창 밖 내 말') }));
  });

  it('retries the 100-message backfill after Discord rejects a user post', async () => {
    const { bridge, stateManager } = createBridge(1000);
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 500, lastActivityAt: 500,
      lastSyncedMessageId: 'assistant-after', lastSyncedMessageContent: '답변', userMirrorSince: 1000, status: 'active',
    });
    const messages = vi.fn(async ({ limit }: { limit?: number }) => ({ data: limit === 100
      ? [
          { id: 'assistant-after', type: 'assistant', content: [{ type: 'text', text: '답변' }] },
          { id: 'user-missed', type: 'user', time: { created: 2000 }, text: '재시도할 내 말' },
        ]
      : [{ id: 'assistant-after', type: 'assistant', content: [{ type: 'text', text: '답변' }] }],
    }));
    const thread = { send: vi.fn().mockRejectedValueOnce(new Error('Discord unavailable')).mockResolvedValue(undefined) };
    const options = {
      client: createClient({ messages }), threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1',
      projectPath: '/repo', sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread, historyLimit: 5,
    };
    await expect(bridge.replaySessionHistory(options)).rejects.toThrow('Discord unavailable');
    expect(stateManager.sessions.get('thread-1')?.lastSyncedUserMessageId).toBeUndefined();
    await bridge.replaySessionHistory(options);
    expect(messages.mock.calls.filter(([input]) => input.limit === 100)).toHaveLength(2);
    expect(stateManager.sessions.get('thread-1')?.lastSyncedUserMessageId).toBe('user-missed');
  });

  it('serializes an SSE-triggered replay behind a polling replay for the same thread', async () => {
    const { bridge, stateManager } = createBridge(1000);
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 500, lastActivityAt: 500,
      lastSyncedMessageId: 'assistant-old', lastSyncedMessageContent: 'old', userMirrorSince: 1000, status: 'active',
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => undefined;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const messages = vi.fn()
      .mockImplementationOnce(async () => { started(); await gate; return { data: [{ id: 'assistant-old', type: 'assistant', content: [{ type: 'text', text: 'old' }] }] }; })
      .mockResolvedValue({ data: [
        { id: 'user-new', type: 'user', time: { created: 2000 }, text: '바로 전송' },
        { id: 'assistant-old', type: 'assistant', content: [{ type: 'text', text: 'old' }] },
      ] });
    const thread = { send: vi.fn(async () => undefined) };
    const options = {
      client: createClient({ messages }), threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1',
      projectPath: '/repo', sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    };
    const polling = bridge.replaySessionHistory(options);
    await begun;
    const event = bridge.replaySessionHistory(options);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsBeforeRelease = messages.mock.calls.length;
    release();
    await Promise.all([polling, event]);
    expect(callsBeforeRelease).toBe(1);
    expect(thread.send).toHaveBeenCalledOnce();
    expect(thread.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('바로 전송') }));
    expect(stateManager.sessions.get('thread-1')?.lastSyncedMessageId).toBe('user-new');
  });

  it.each(['**User:**', '**나:**'])('records a previously mirrored user message without sending it again (%s)', async (prefix) => {
    const { bridge, stateManager } = createBridge(1000);
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 500, lastActivityAt: 500,
      lastSyncedMessageId: 'assistant-after', lastSyncedMessageContent: '답변', userMirrorSince: 1000, status: 'active',
    });
    const thread = {
      send: vi.fn(async () => undefined),
      messages: { fetch: vi.fn(async () => new Map([['discord-1', {
        author: { bot: true }, content: `${prefix}\n> 이전 전송`, createdTimestamp: 2100,
      }]])) },
    };
    await bridge.replaySessionHistory({
      client: createClient({ messages: vi.fn(async () => ({ data: [
        { id: 'assistant-after', type: 'assistant', content: [{ type: 'text', text: '답변' }] },
        { id: 'user-already', type: 'user', time: { created: 2000 }, text: '이전 전송' },
      ] })) }),
      threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    });
    expect(thread.send).not.toHaveBeenCalled();
    expect(stateManager.sessions.get('thread-1')?.lastSyncedUserMessageId).toBe('user-already');
  });

  it('reports the latest visible assistant timestamp for delivery monitoring', async () => {
    const { bridge } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    const client = createClient({ messages: vi.fn(async () => ({ data: { data: [
      { id: 'assistant-new', type: 'assistant', time: { created: 1000, completed: 3000 }, content: [{ type: 'reasoning', text: '생각' }] },
      { id: 'user-old', type: 'user', time: { created: 500 }, content: [{ type: 'text', text: '질문' }] },
    ] } })) });
    const result = await bridge.replaySessionHistory({
      client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    });
    expect(result.latestAssistantAt).toBe(3000);
  });

  it('does not dedupe an empty assistant message before its text is delivered', async () => {
    const { bridge, stateManager } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'user-old', status: 'active',
    });
    const messages = vi.fn()
      .mockResolvedValueOnce({ data: [
        { id: 'assistant-new', type: 'assistant', content: [{ type: 'tool' }] },
        { id: 'user-old', type: 'user', content: [{ type: 'text', text: '질문' }] },
      ] })
      .mockResolvedValueOnce({ data: [
        { id: 'assistant-new', type: 'assistant', content: [{ type: 'reasoning', text: '전달할 응답' }] },
        { id: 'user-old', type: 'user', content: [{ type: 'text', text: '질문' }] },
      ] });
    const options = {
      client: createClient({ messages }), threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1',
      projectPath: '/repo', sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    };
    await bridge.replaySessionHistory(options);
    expect(bridge.getDedupeSet('thread-1').has('assistant-new')).toBe(false);
    await bridge.replaySessionHistory(options);
    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('전달할 응답'));
  });

  it('replays text added later to an assistant message already used as the sync marker', async () => {
    const { bridge, stateManager } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      createdAt: 1000,
      lastActivityAt: 1000,
      lastSyncedMessageId: 'assistant-1',
      lastSyncedMessageContent: '',
      status: 'active',
    });
    const client = createClient({
      messages: vi.fn(async () => ({
        data: [
          { id: 'assistant-1', type: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
          { id: 'user-1', type: 'user', content: [{ type: 'text', text: 'question' }] },
        ],
      })),
    });

    await bridge.replaySessionHistory({
      client,
      threadId: 'thread-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      sessionId: 'session-1',
      agent: 'build',
      model: null,
      createdBy: 'user-1',
      thread,
    });

    expect(thread.send).toHaveBeenCalledTimes(1);
    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('final answer'));
  });

  it('never replays system message text to Discord', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'user-old', status: 'active',
    });
    const client = createClient({ messages: vi.fn(async () => ({ data: [
      { id: 'assistant-new', type: 'assistant', content: [{ type: 'text', text: 'normal answer' }] },
      { id: 'system-new', type: 'system', content: [{ type: 'text', text: 'internal tool catalog' }] },
      { id: 'user-old', type: 'user', content: [{ type: 'text', text: 'question' }] },
    ] })) });

    await bridge.replaySessionHistory({
      client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    });

    expect(thread.send).toHaveBeenCalledOnce();
    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('normal answer'));
    expect(thread.send).not.toHaveBeenCalledWith(expect.stringContaining('internal tool catalog'));
    expect(streamSubscriber.refreshTypingForThread).toHaveBeenCalledWith('thread-1');
  });

  it('recovers assistant reasoning but never synthetic text from history', async () => {
    const { bridge, stateManager } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'user-old', status: 'active',
    });
    const client = createClient({ messages: vi.fn(async () => ({ data: [
      { info: { id: 'assistant-new', role: 'assistant' }, parts: [
        { type: 'reasoning', text: '생각 중' }, { type: 'text', text: '완료' },
        { type: 'text', text: '비공개', synthetic: true },
      ] },
      { info: { id: 'user-old', role: 'user' }, parts: [{ type: 'text', text: '질문' }] },
    ] })) });
    await bridge.replaySessionHistory({
      client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    });
    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('생각 중'));
    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('완료'));
    expect(thread.send).not.toHaveBeenCalledWith(expect.stringContaining('비공개'));
  });

  it('stops typing when polling observes an idle message', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000, status: 'active',
    });
    const client = createClient({ messages: vi.fn(async () => ({ data: [
      { id: 'idle-1', type: 'idle', content: [] },
      { id: 'assistant-1', type: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] })) });

    await bridge.replaySessionHistory({
      client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    });

    expect(streamSubscriber.stopTypingForThread).toHaveBeenCalledWith('thread-1');
  });

  it('stops typing when polling observes a completed assistant message', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'user-1', status: 'active',
    });
    const client = createClient({ messages: vi.fn(async () => ({ data: [
      { id: 'assistant-1', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'done' }] },
      { id: 'user-1', type: 'user', content: [{ type: 'text', text: 'work' }] },
    ] })) });

    await bridge.replaySessionHistory({
      client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    });

    expect(streamSubscriber.stopTypingForThread).toHaveBeenCalledWith('thread-1');
  });

  it('starts typing when polling observes new work submitted outside Discord', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'assistant-old', status: 'active',
    });
    const client = createClient({ messages: vi.fn(async () => ({ data: [
      { id: 'user-new', type: 'user', content: [{ type: 'text', text: 'new work' }] },
      { id: 'assistant-old', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'old answer' }] },
    ] })) });

    await bridge.replaySessionHistory({
      client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    });

    expect(streamSubscriber.refreshTypingForThread).toHaveBeenCalledWith('thread-1');
  });

  it('starts typing when polling observes a running history tool after restart', async () => {
    const { bridge, stateManager, streamSubscriber } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'user-1', status: 'active',
    });
    const client = createClient({ messages: vi.fn(async () => ({ data: [
      { id: 'assistant-1', type: 'assistant', content: [{ type: 'tool', state: { status: 'running' } }] },
      { id: 'user-1', type: 'user', content: [{ type: 'text', text: 'work' }] },
    ] })) });

    await bridge.replaySessionHistory({
      client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', thread,
    });

    expect(streamSubscriber.refreshTypingForThread).toHaveBeenCalledWith('thread-1');
  });

  it('loads full history when a disconnected gap exceeds the polling limit', async () => {
    const { bridge, stateManager } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'assistant-old', lastSyncedMessageContent: 'old answer', status: 'active',
    });
    const messages = vi.fn(async (options: { limit?: number }) => ({ data: options.limit === 100
      ? [
          { id: 'assistant-new', type: 'assistant', content: [{ type: 'text', text: 'missed answer' }] },
          { id: 'user-new', type: 'user', content: [{ type: 'text', text: 'new question' }] },
          { id: 'assistant-old', type: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
        ]
      : [{ id: 'assistant-new', type: 'assistant', content: [{ type: 'text', text: 'missed answer' }] }],
    }));
    const client = createClient({ messages });

    await bridge.replaySessionHistory({
      client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', historyLimit: 5, thread,
    });

    expect(messages).toHaveBeenNthCalledWith(2, { sessionID: 'session-1', limit: 100 });
    expect(thread.send).toHaveBeenCalledOnce();
    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('missed answer'));
  });

  it('does not duplicate history when the saved marker is temporarily absent', async () => {
    const { bridge, stateManager } = createBridge();
    const thread = { send: vi.fn(async () => undefined) };
    stateManager.sessions.set('thread-1', {
      sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      agent: 'build', model: null, createdBy: 'user-1', createdAt: 1000, lastActivityAt: 1000,
      lastSyncedMessageId: 'expired-marker', lastSyncedMessageContent: 'old', status: 'active',
    });
    const client = createClient({ messages: vi.fn(async () => ({ data: { data: [
      { id: 'assistant-new', type: 'assistant', content: [{ type: 'text', text: 'recovered answer' }] },
      { id: 'user-new', type: 'user', content: [{ type: 'text', text: 'question' }] },
    ] } })) });

    await bridge.replaySessionHistory({
      client, threadId: 'thread-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/repo',
      sessionId: 'session-1', agent: 'build', model: null, createdBy: 'user-1', historyLimit: 5, thread,
    });

    expect(thread.send).not.toHaveBeenCalled();
    expect(stateManager.sessions.get('thread-1')?.lastSyncedMessageId).toBe('expired-marker');
  });

  it('aborts an active session through the SDK client', async () => {
    const { bridge, stateManager } = createBridge();
    const client = createClient();
    stateManager.sessions.set('thread-1', {
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
    });

    await bridge.abortSession('thread-1', client);

    expect(client.session.abort).toHaveBeenCalledWith({ sessionID: 'session-1' });
  });

  it('throws and preserves activity time when promptAsync returns an SDK error envelope', async () => {
    const { bridge, stateManager } = createBridge(2000);
    const client = createClient({ promptAsync: vi.fn(async () => ({ error: { name: 'NotFoundError' } })) });
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
    stateManager.sessions.set('thread-1', session);

    await expect(bridge.sendPrompt('thread-1', { client, content: 'hello' })).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    });

    expect(stateManager.setSession).not.toHaveBeenCalled();
    expect(stateManager.sessions.get('thread-1')).toEqual(session);
  });

  it('rejects providerless stored models before calling the SDK or updating state', async () => {
    const { bridge, stateManager } = createBridge(2000);
    const client = createClient();
    const session: SessionState = {
      sessionId: 'session-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      projectPath: '/repo',
      agent: 'build',
      model: 'claude',
      createdBy: 'user-1',
      createdAt: 1000,
      lastActivityAt: 1000,
      status: 'active',
    };
    stateManager.sessions.set('thread-1', session);

    await expect(bridge.sendPrompt('thread-1', { client, content: 'hello' })).rejects.toMatchObject({
      code: ErrorCode.MODEL_NOT_FOUND,
    });

    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(stateManager.setSession).not.toHaveBeenCalled();
    expect(stateManager.sessions.get('thread-1')).toEqual(session);
  });

  it('throws when abort returns an SDK error envelope', async () => {
    const { bridge, stateManager } = createBridge();
    const client = createClient({ abort: vi.fn(async () => ({ error: { name: 'AbortFailed' } })) });
    stateManager.sessions.set('thread-1', {
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
    });

    await expect(bridge.abortSession('thread-1', client)).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    });
  });

  it('throws SESSION_NOT_FOUND when sending to an absent session', async () => {
    const { bridge } = createBridge();

    await expect(bridge.sendPrompt('missing-thread', { client: createClient(), content: 'hello' })).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    });
  });
});
