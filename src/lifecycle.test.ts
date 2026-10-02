import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerLifecycleHandlers } from './discord/client.js';
import type { BotState, ServerState, SessionState } from './state/types.js';

class FakeStateManager {
  public readonly state: BotState;

  public constructor(state: BotState) {
    this.state = state;
  }

  public getState(): BotState {
    return this.state;
  }

  public getSession(threadId: string): SessionState | undefined {
    return this.state.sessions[threadId];
  }

  public setSession(threadId: string, session: SessionState): void {
    this.state.sessions[threadId] = session;
  }

  public setServer(projectPath: string, server: ServerState): void {
    this.state.servers[projectPath] = server;
  }
}

class FakeProcess extends EventEmitter {
  public onSignals: string[] = [];
  public offSignals: string[] = [];

  public override on(eventName: string, listener: (...args: unknown[]) => void): this {
    this.onSignals.push(eventName);
    return super.on(eventName, listener);
  }

  public override off(eventName: string, listener: (...args: unknown[]) => void): this {
    this.offSignals.push(eventName);
    return super.off(eventName, listener);
  }
}

class FakeClient extends EventEmitter {
  public destroyed = false;
  public channels = {
    fetch: vi.fn<(threadId: string) => Promise<{ setArchived: (archived: boolean) => Promise<void> } | null>>(),
  };

  public destroy(): void {
    this.destroyed = true;
  }
}

const NOW = 1_700_000_000_000;

function createSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 'session-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    projectPath: '/workspace/project',
    agent: 'build',
    model: null,
    createdBy: 'user-1',
    createdAt: NOW - 1000,
    lastActivityAt: NOW,
    status: 'active',
    ...overrides,
  };
}

function createServer(overrides: Partial<ServerState> = {}): ServerState {
  return {
    port: 4096,
    pid: 1234,
    url: 'http://127.0.0.1:4096',
    startedAt: NOW - 5000,
    status: 'running',
    ...overrides,
  };
}

async function flushSignalShutdown(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('registerLifecycleHandlers', () => {
  it('marks a deleted thread session ended after best-effort abort', async () => {
    const client = new FakeClient();
    const stateManager = new FakeStateManager({
      version: 1,
      servers: {},
      sessions: { 'thread-1': createSession({ sessionId: 'session-1' }) },
      queues: {},
    });
    const abortSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    registerLifecycleHandlers(client, {
      stateManager,
      serverManager: { shutdownAll: vi.fn<() => Promise<void>>() },
      abortSession,
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });

    client.emit('threadDelete', { id: 'thread-1' });
    await Promise.resolve();

    expect(abortSession).toHaveBeenCalledWith('thread-1', stateManager.state.sessions['thread-1']);
    expect(stateManager.state.sessions['thread-1']?.status).toBe('ended');
  });

  it('archives inactive threads and marks their sessions inactive', async () => {
    const client = new FakeClient();
    const setArchived = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    client.channels.fetch.mockResolvedValue({ setArchived });
    const stateManager = new FakeStateManager({
      version: 1,
      servers: {},
      sessions: {
        stale: createSession({ lastActivityAt: NOW - 24 * 60 * 60 * 1000 - 1 }),
        recent: createSession({ lastActivityAt: NOW - 60_000 }),
      },
      queues: {},
    });

    const controller = registerLifecycleHandlers(client, {
      stateManager,
      serverManager: { shutdownAll: vi.fn<() => Promise<void>>() },
      abortSession: vi.fn<() => Promise<void>>(),
      now: () => NOW,
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });

    await controller.runInactivityCheck();

    expect(client.channels.fetch).toHaveBeenCalledWith('stale');
    expect(setArchived).toHaveBeenCalledWith(true);
    expect(stateManager.state.sessions.stale?.status).toBe('inactive');
    expect(stateManager.state.sessions.recent?.status).toBe('active');
  });

  it('aborts live sessions, shuts down servers, marks servers stopped, and destroys Discord on shutdown', async () => {
    const client = new FakeClient();
    const stateManager = new FakeStateManager({
      version: 1,
      servers: {
        '/workspace/one': createServer({ port: 4001 }),
        '/workspace/two': createServer({ port: 4002, status: 'stopped' }),
      },
      sessions: {
        active: createSession({ status: 'active' }),
        inactive: createSession({ status: 'inactive' }),
        ended: createSession({ status: 'ended' }),
      },
      queues: {},
    });
    const abortSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const shutdownAll = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const controller = registerLifecycleHandlers(client, {
      stateManager,
      serverManager: { shutdownAll },
      abortSession,
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    });

    await controller.shutdown();

    expect(abortSession).toHaveBeenCalledTimes(2);
    expect(abortSession).toHaveBeenCalledWith('active', stateManager.state.sessions.active);
    expect(abortSession).toHaveBeenCalledWith('inactive', stateManager.state.sessions.inactive);
    expect(shutdownAll).toHaveBeenCalledOnce();
    expect(stateManager.state.servers['/workspace/one']?.status).toBe('stopped');
    expect(stateManager.state.servers['/workspace/two']?.status).toBe('stopped');
    expect(client.destroyed).toBe(true);
  });

  it('registers SIGINT and SIGTERM handlers that trigger shutdown and are disposable', async () => {
    const client = new FakeClient();
    const processLike = new FakeProcess();
    const clearInterval = vi.fn();
    const exit = vi.fn();
    const timer = 42;
    const stateManager = new FakeStateManager({
      version: 1,
      servers: {},
      sessions: { active: createSession() },
      queues: {},
    });
    const abortSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const controller = registerLifecycleHandlers(client, {
      stateManager,
      serverManager: { shutdownAll: vi.fn<() => Promise<void>>() },
      abortSession,
      processLike,
      setInterval: vi.fn(() => timer),
      clearInterval,
      exit,
    });

    processLike.emit('SIGINT');
    await flushSignalShutdown();

    expect(processLike.onSignals).toContain('SIGINT');
    expect(processLike.onSignals).toContain('SIGTERM');
    expect(abortSession).toHaveBeenCalledOnce();
    expect(client.destroyed).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);

    controller.dispose();

    expect(clearInterval).toHaveBeenCalledWith(timer);
    expect(processLike.offSignals).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('treats SIGTERM as terminal by shutting down, disposing, and exiting', async () => {
    const client = new FakeClient();
    const processLike = new FakeProcess();
    const clearInterval = vi.fn();
    const exit = vi.fn();
    const timer = 99;
    const stateManager = new FakeStateManager({
      version: 1,
      servers: { '/workspace/project': createServer() },
      sessions: { active: createSession() },
      queues: {},
    });
    const abortSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const shutdownAll = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    registerLifecycleHandlers(client, {
      stateManager,
      serverManager: { shutdownAll },
      abortSession,
      processLike,
      setInterval: vi.fn(() => timer),
      clearInterval,
      exit,
    });

    processLike.emit('SIGTERM');
    await flushSignalShutdown();

    expect(abortSession).toHaveBeenCalledWith('active', stateManager.state.sessions.active);
    expect(shutdownAll).toHaveBeenCalledOnce();
    expect(client.destroyed).toBe(true);
    expect(clearInterval).toHaveBeenCalledWith(timer);
    expect(processLike.offSignals).toEqual(['SIGINT', 'SIGTERM']);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
