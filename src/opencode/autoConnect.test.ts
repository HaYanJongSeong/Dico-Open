import { describe, expect, it, vi } from 'vitest';
import { StreamHandler } from './streamHandler.js';
import type { AutoConnectDelegate, GlobalEventLike, OpenCodeStreamClient, StreamHandlerOptions, StreamMessage, StreamThread } from './streamHandler.js';

function stream(events: GlobalEventLike[]): AsyncIterable<GlobalEventLike> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function failingStream(error: Error): AsyncIterable<GlobalEventLike> {
  return {
    async *[Symbol.asyncIterator]() {
      throw error;
    },
  };
}

function createClient(events: AsyncIterable<GlobalEventLike>[]): OpenCodeStreamClient {
  let index = 0;

  return {
    global: {
      event: vi.fn(async () => events[index++] ?? stream([])),
    },
  };
}

function createThread(): { thread: StreamThread; sends: string[] } {
  const sends: string[] = [];
  const message: StreamMessage = { edit: vi.fn(async () => undefined) };
  return {
    sends,
    thread: {
      send: vi.fn(async (content: string) => {
        sends.push(content);
        return message;
      }),
    },
  };
}

function createHandler(options: Partial<StreamHandlerOptions>, thread = createThread().thread): StreamHandler {
  return new StreamHandler({
    getThread: () => thread,
    questionHandler: { handleQuestionEvent: vi.fn(async () => undefined) },
    permissionHandler: { handlePermissionEvent: vi.fn(async () => undefined) },
    retryDelayMs: 0,
    ...options,
  });
}

describe('StreamHandler auto-connect', () => {
  it('delegates session.created events with project path and session info', async () => {
    const session = { id: 'session-new', title: 'New work' };
    const autoConnectHandler: AutoConnectDelegate = {
      isSessionAttached: vi.fn(() => false),
      handleSessionCreated: vi.fn(async () => undefined),
    };
    const handler = createHandler({ autoConnectHandler });
    const client = createClient([stream([{ directory: '/repo', payload: { type: 'session.created', info: session } }])]);

    await handler.subscribe('thread-1', 'existing-session', client, undefined, '/repo');
    await handler.waitForIdle('thread-1');

    expect(autoConnectHandler.isSessionAttached).toHaveBeenCalledWith('session-new');
    expect(autoConnectHandler.handleSessionCreated).toHaveBeenCalledWith('/repo', session, client);
  });

  it('skips session.created events for already attached sessions', async () => {
    const session = { sessionID: 'attached-session' };
    const autoConnectHandler: AutoConnectDelegate = {
      isSessionAttached: vi.fn(() => true),
      handleSessionCreated: vi.fn(async () => undefined),
    };
    const handler = createHandler({ autoConnectHandler });
    const client = createClient([stream([{ directory: '/repo', payload: { type: 'session.created', info: session } }])]);

    await handler.subscribe('thread-1', 'existing-session', client, undefined, '/repo');
    await handler.waitForIdle('thread-1');

    expect(autoConnectHandler.isSessionAttached).toHaveBeenCalledWith('attached-session');
    expect(autoConnectHandler.handleSessionCreated).not.toHaveBeenCalled();
  });

  it('recovers missed sessions after an SSE reconnect', async () => {
    const autoConnectHandler: AutoConnectDelegate = {
      isSessionAttached: vi.fn(() => false),
      handleSessionCreated: vi.fn(async () => undefined),
      recoverMissedSessions: vi.fn(async () => undefined),
    };
    const handler = createHandler({ autoConnectHandler, maxRetries: 1 });
    const client = createClient([failingStream(new Error('disconnect')), stream([])]);

    await handler.subscribe('thread-1', 'existing-session', client, undefined, '/repo');
    await handler.waitForIdle('thread-1');

    expect(client.global.event).toHaveBeenCalledTimes(2);
    expect(autoConnectHandler.recoverMissedSessions).toHaveBeenCalledTimes(1);
    expect(autoConnectHandler.recoverMissedSessions).toHaveBeenCalledWith('/repo', client);
  });

  it('contains auto-connect failures so streaming can continue', async () => {
    const autoConnectHandler: AutoConnectDelegate = {
      isSessionAttached: vi.fn(() => false),
      handleSessionCreated: vi.fn(async () => {
        throw new Error('discord unavailable');
      }),
    };
    const handler = createHandler({ autoConnectHandler });
    const client = createClient([
      stream([
        { directory: '/repo', payload: { type: 'session.created', info: { id: 'session-new' } } },
        { directory: '/repo', payload: { type: 'message.part.delta', sessionID: 'existing-session', partID: 'part-1', field: 'text', delta: 'still streaming', part: { id: 'part-1', type: 'text' } } },
      ]),
    ]);

    await handler.subscribe('thread-1', 'existing-session', client, undefined, '/repo');

    await expect(handler.waitForIdle('thread-1')).resolves.toBeUndefined();
  });

  it('contains attached-session lookup failures so streaming can continue', async () => {
    const { thread, sends } = createThread();
    const autoConnectHandler: AutoConnectDelegate = {
      isSessionAttached: vi.fn(() => {
        throw new Error('state unavailable');
      }),
      handleSessionCreated: vi.fn(async () => undefined),
    };
    const handler = createHandler({ autoConnectHandler, maxRetries: 0 }, thread);
    const client = createClient([
      stream([
        { directory: '/repo', payload: { type: 'session.created', info: { id: 'session-new' } } },
        { directory: '/repo', payload: { type: 'message.part.delta', sessionID: 'existing-session', partID: 'part-1', field: 'text', delta: 'still streaming', part: { id: 'part-1', type: 'text' } } },
      ]),
    ]);

    await handler.subscribe('thread-1', 'existing-session', client, undefined, '/repo');
    await handler.waitForIdle('thread-1');

    expect(client.global.event).toHaveBeenCalledTimes(1);
    expect(autoConnectHandler.handleSessionCreated).not.toHaveBeenCalled();
    expect(sends).toEqual(['still streaming']);
  });

  it('exposes startup missed-session recovery through the auto-connect delegate', async () => {
    const autoConnectHandler: AutoConnectDelegate = {
      isSessionAttached: vi.fn(() => false),
      handleSessionCreated: vi.fn(async () => undefined),
      recoverMissedSessions: vi.fn(async () => undefined),
    };
    const handler = createHandler({ autoConnectHandler });
    const client = createClient([]);

    await expect((handler as { recoverMissedSessions(projectPath: string, client: OpenCodeStreamClient): Promise<void> }).recoverMissedSessions('/repo', client)).resolves.toBeUndefined();

    expect(autoConnectHandler.recoverMissedSessions).toHaveBeenCalledWith('/repo', client);
  });
});
