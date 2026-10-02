import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { allocateFreePort, createServerClient, getOpenCodeExecutable, ServerManager } from './serverManager.js';
import type { ServerState } from '../state/types.js';
import type { ServerManagerClient } from './serverManager.js';
import { ErrorCode } from '../utils/errors.js';

class MockProcess extends EventEmitter {
  public killed = false;
  public stdout?: { resume: ReturnType<typeof vi.fn<() => void>> };
  public stderr?: { resume: ReturnType<typeof vi.fn<() => void>> };

  public constructor(public readonly pid: number) {
    super();
  }

  public kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

interface MockStateManager {
  getServer: ReturnType<typeof vi.fn<(projectPath: string) => ServerState | undefined>>;
  setServer: ReturnType<typeof vi.fn<(projectPath: string, server: ServerState) => void>>;
  removeServer: ReturnType<typeof vi.fn<(projectPath: string) => void>>;
}

type TestClient = ServerManagerClient & { id: string };

function createStateManager(): MockStateManager {
  return {
    getServer: vi.fn(),
    setServer: vi.fn(),
    removeServer: vi.fn(),
  };
}

function createClient(id: string): TestClient {
  return {
    id,
    global: {
      health: vi.fn(async () => ({ healthy: true })),
    },
  } as unknown as TestClient;
}

async function expectStartupFailure(promise: Promise<ServerManagerClient>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code: ErrorCode.SERVER_START_FAILED,
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
}

describe('allocateFreePort', () => {
  it('allocates a free localhost port with net.createServer', async () => {
    const port = await allocateFreePort();

    expect(port).toBeGreaterThan(0);
  });
});

it('allows a published installation to find OpenCode outside the npm-global directory', () => {
  const previous = process.env.OPENCODE_EXECUTABLE;
  try {
    process.env.OPENCODE_EXECUTABLE = 'C:\\Tools\\opencode.exe';
    expect(getOpenCodeExecutable()).toBe('C:\\Tools\\opencode.exe');
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_EXECUTABLE;
    else process.env.OPENCODE_EXECUTABLE = previous;
  }
});

describe('createServerClient', () => {
  it('roots legacy routes at /api and CLI v2 routes at the server origin', () => {
    const client = createServerClient('http://127.0.0.1:49374', { Authorization: 'Basic test' });

    expect((client as any).session.client.getConfig().baseUrl).toBe('http://127.0.0.1:49374/api');
    expect((client as any).v2Root.event.client.getConfig().baseUrl).toBe('http://127.0.0.1:49374');
  });

  it('checks the CLI v2 /api/info JSON route for health', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"version":"2.0","pid":1}', {
      headers: { 'Content-Type': 'application/json' },
    }));
    try {
      const result = await createServerClient('http://127.0.0.1:49374', { Authorization: 'Basic test' }).global.health();
      expect(fetchMock.mock.calls[0]?.[0] instanceof Request ? (fetchMock.mock.calls[0]?.[0] as Request).url : fetchMock.mock.calls[0]?.[0])
        .toBe('http://127.0.0.1:49374/api/info');
      expect(result.data).toEqual({ healthy: true });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('does not accept an HTML fallback page as proof of server health', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>not a health result</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));
    try {
      const result = await createServerClient('http://127.0.0.1:49374', { Authorization: 'Basic test' }).global.health();
      expect(result).not.toMatchObject({ data: { healthy: true } });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('adapts permission replies to the current CLI v2 decision body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const client = createServerClient('http://127.0.0.1:49374', { Authorization: 'Basic test' });

    await (client as any).v2Root.session.permission.reply({ sessionID: 'ses_1', requestID: 'per_1', reply: 'always' });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:49374/api/session/ses_1/permission/per_1/reply', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ decision: 'always' }),
    }));
  });

  it('passes Discord-origin metadata through the v2 prompt adapter', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"data":{"id":"msg_1"}}', { status: 200 }));
    const client = createServerClient('http://127.0.0.1:49374', { Authorization: 'Basic test' });
    await (client as any).v2Root.session.prompt({ sessionID: 'ses_1', text: '질문', metadata: { opencodeDiscordOrigin: true }, delivery: 'steer' });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:49374/api/session/ses_1/prompt', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ text: '질문', delivery: 'steer', metadata: { opencodeDiscordOrigin: true } }),
    }));
  });

  it('exposes the form question adapter on the client root used by the stream handler', () => {
    const client = createServerClient('http://127.0.0.1:49374', { Authorization: 'Basic test' });

    expect(typeof client.question.reply).toBe('function');
    expect(typeof client.question.reject).toBe('function');
    expect((client as any).session.question).toBe((client as any).question);
    expect((client as any).v2Root.session.question).toBe((client as any).question);
  });

  it('adapts question replies to the current CLI v2 form answer route', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const client = createServerClient('http://127.0.0.1:49374', { Authorization: 'Basic test' });

    await (client as any).session.question.reply({ sessionID: 'ses_1', requestID: 'frm_1', answer: { choice: 'yes' } });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:49374/api/session/ses_1/form/frm_1/reply', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ answer: { choice: 'yes' } }),
    }));
  });

  it('adapts question rejection to the current CLI v2 form cancel route', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const client = createServerClient('http://127.0.0.1:49374', { Authorization: 'Basic test' });

    await (client as any).session.question.reject({ sessionID: 'ses_1', requestID: 'frm_1' });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:49374/api/session/ses_1/form/frm_1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('adapts abort to the current interrupt route', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const client = createServerClient('http://127.0.0.1:49374', { Authorization: 'Basic test' });

    await client.session.abort({ sessionID: 'ses_1' });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:49374/api/session/ses_1/interrupt', expect.objectContaining({ method: 'POST' }));
  });
});

describe('ServerManager', () => {
  const projectPath = '/tmp/project';
  let stateManager: MockStateManager;
  let process: MockProcess;
  let client: ReturnType<typeof createClient>;

  beforeEach(() => {
    stateManager = createStateManager();
    process = new MockProcess(1234);
    client = createClient('client-1');
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns opencode serve when ensureRunning is called for a stopped project', async () => {
    const spawnProcess = vi.fn(() => process);
    const manager = new ServerManager({
      stateManager,
      spawnProcess,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      now: () => 1000,
    });

    const result = await manager.ensureRunning(projectPath);

    expect(result).toBe(client);
    expect(spawnProcess).toHaveBeenCalledWith(projectPath, 4321);
    expect(stateManager.setServer).toHaveBeenCalledWith(projectPath, {
      port: 4321,
      pid: 1234,
      url: 'http://127.0.0.1:4321',
      startedAt: 1000,
      status: 'running',
    });
  });

  it('returns the existing client without spawning when already running', async () => {
    const spawnProcess = vi.fn(() => process);
    const manager = new ServerManager({
      stateManager,
      spawnProcess,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
    });

    await manager.ensureRunning(projectPath);
    const result = await manager.ensureRunning(projectPath);

    expect(result).toBe(client);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('reuses a registered recovered client without spawning a duplicate server', async () => {
    const spawnProcess = vi.fn(() => process);
    const recoveredState: ServerState = {
      port: 4321,
      pid: 1234,
      url: 'http://127.0.0.1:4321',
      startedAt: 1000,
      status: 'running',
    };
    const manager = new ServerManager({
      stateManager,
      spawnProcess,
      allocatePort: async () => 9999,
      createClient: () => createClient('duplicate-client'),
      healthCheck: async () => true,
    });

    manager.registerRecovered(projectPath, client, recoveredState);

    expect(manager.getClient(projectPath)).toBe(client);
    await expect(manager.ensureRunning(projectPath)).resolves.toBe(client);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(stateManager.setServer).toHaveBeenCalledWith(projectPath, recoveredState);
  });

  it('drains spawned stdout and stderr pipes', async () => {
    process.stdout = { resume: vi.fn() };
    process.stderr = { resume: vi.fn() };
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
    });

    await manager.ensureRunning(projectPath);

    expect(process.stdout.resume).toHaveBeenCalledOnce();
    expect(process.stderr.resume).toHaveBeenCalledOnce();
  });

  it('polls health until the server becomes healthy', async () => {
    const healthCheck = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck,
      startupPollMs: 1,
    });

    await manager.ensureRunning(projectPath);

    expect(healthCheck).toHaveBeenCalledTimes(2);
  });

  it('accepts the default SDK v2 health response shape', async () => {
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      startupPollMs: 1,
    });

    const result = await manager.ensureRunning(projectPath);

    expect(result).toBe(client);
    expect(client.global.health).toHaveBeenCalled();
  });

  it('does not treat a failed session list response as a healthy server', async () => {
    const unhealthy = {
      global: { health: vi.fn(async () => ({ error: 'missing' })) },
      session: { list: vi.fn(async () => ({ error: 'unavailable' })) },
    } as unknown as TestClient;
    let clock = 0;
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => unhealthy,
      startupPollMs: 1,
      startupTimeoutMs: 2,
      now: () => ++clock,
    });

    await expect(manager.ensureRunning(projectPath)).rejects.toMatchObject({ code: ErrorCode.SERVER_START_FAILED });
    expect(unhealthy.session.list).toHaveBeenCalled();
  });

  it('only allows restarts of servers started by this bot process', async () => {
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
    });
    expect(manager.canRestart(projectPath)).toBe(false);
    await manager.ensureRunning(projectPath);
    expect(manager.canRestart(projectPath)).toBe(true);

    const recovered = new ServerManager({ stateManager, healthCheck: async () => true });
    recovered.registerRecovered(projectPath, client, { port: 4321, pid: 1234, url: 'http://127.0.0.1:4321', startedAt: 1, status: 'running' });
    expect(recovered.canRestart(projectPath)).toBe(false);
  });

  it('shares an in-flight cold start for concurrent ensureRunning calls', async () => {
    let resolvePort: (port: number) => void = () => undefined;
    const portPromise = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    const spawnProcess = vi.fn(() => process);
    const manager = new ServerManager({
      stateManager,
      spawnProcess,
      allocatePort: () => portPromise,
      createClient: () => client,
      healthCheck: async () => true,
    });

    const first = manager.ensureRunning(projectPath);
    const second = manager.ensureRunning(projectPath);
    resolvePort(4321);

    await expect(Promise.all([first, second])).resolves.toEqual([client, client]);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('rejects startup and does not track a client when the process emits error', async () => {
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => await new Promise<boolean>(() => undefined),
    });

    const startup = manager.ensureRunning(projectPath);
    await flushPromises();
    process.emit('error', new Error('spawn failed'));

    await expectStartupFailure(startup);
    expect(stateManager.setServer).not.toHaveBeenCalled();
    expect(manager.getClient(projectPath)).toBeUndefined();
  });

  it('rejects startup and does not track a client when the process exits before healthy', async () => {
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => await new Promise<boolean>(() => undefined),
    });

    const startup = manager.ensureRunning(projectPath);
    await flushPromises();
    process.emit('exit', 1, null);

    await expectStartupFailure(startup);
    expect(stateManager.setServer).not.toHaveBeenCalled();
    expect(manager.getClient(projectPath)).toBeUndefined();
  });

  it('removes the client and marks the server stopped when the process exits', async () => {
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      now: () => 1000,
    });
    await manager.ensureRunning(projectPath);

    process.emit('exit', 1, null);

    expect(manager.getClient(projectPath)).toBeUndefined();
    expect(stateManager.setServer).toHaveBeenLastCalledWith(projectPath, {
      port: 4321,
      pid: 1234,
      url: 'http://127.0.0.1:4321',
      startedAt: 1000,
      status: 'stopped',
    });
  });

  it('shuts down an idle server after the idle timeout', async () => {
    vi.useFakeTimers();
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      idleTimeoutMs: 50,
    });
    await manager.ensureRunning(projectPath);

    manager.scheduleIdleShutdown(projectPath);
    await vi.advanceTimersByTimeAsync(50);

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not schedule idle shutdown for auto-connect projects', async () => {
    vi.useFakeTimers();
    const manager = new ServerManager({
      stateManager,
      autoConnectProjects: new Set([projectPath]),
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      idleTimeoutMs: 50,
    });
    await manager.ensureRunning(projectPath);

    manager.scheduleIdleShutdown(projectPath);
    await vi.advanceTimersByTimeAsync(100);

    expect(process.kill).not.toHaveBeenCalled();
  });

  it('kills and marks a server stopped after process exits during graceful shutdown', async () => {
    process.kill.mockImplementation((signal?: NodeJS.Signals) => {
      if (signal === 'SIGTERM') {
        process.emit('exit', 0, signal);
      }
      return true;
    });
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      now: () => 1000,
      shutdownTimeoutMs: 50,
    });
    await manager.ensureRunning(projectPath);

    await manager.shutdown(projectPath);

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(process.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(manager.getClient(projectPath)).toBeUndefined();
    expect(stateManager.setServer).toHaveBeenLastCalledWith(projectPath, {
      port: 4321,
      pid: 1234,
      url: 'http://127.0.0.1:4321',
      startedAt: 1000,
      status: 'stopped',
    });
  });

  it('force kills and resolves shutdown when the process does not exit before timeout', async () => {
    vi.useFakeTimers();
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      now: () => 1000,
      shutdownTimeoutMs: 50,
    });
    await manager.ensureRunning(projectPath);

    const shutdown = manager.shutdown(projectPath);
    await vi.advanceTimersByTimeAsync(50);
    await shutdown;

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    expect(manager.getClient(projectPath)).toBeUndefined();
  });

  it('waits for an in-flight shutdown when shutdown is called concurrently', async () => {
    vi.useFakeTimers();
    let secondResolved = false;
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck: async () => true,
      shutdownTimeoutMs: 50,
    });
    await manager.ensureRunning(projectPath);

    const first = manager.shutdown(projectPath);
    const second = manager.shutdown(projectPath);
    void second.then(() => {
      secondResolved = true;
    });
    await flushPromises();

    expect(secondResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([first, second]);

    expect(secondResolved).toBe(true);
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('starts a fresh server when ensureRunning is called during shutdown', async () => {
    vi.useFakeTimers();
    const freshProcess = new MockProcess(5678);
    const freshClient = createClient('client-2');
    const processes = [process, freshProcess];
    const clients = [client, freshClient];
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => processes.shift()!,
      allocatePort: vi.fn()
        .mockResolvedValueOnce(4321)
        .mockResolvedValueOnce(4322),
      createClient: () => clients.shift()!,
      healthCheck: async () => true,
      shutdownTimeoutMs: 50,
      now: () => 1000,
    });
    await manager.ensureRunning(projectPath);

    const shutdown = manager.shutdown(projectPath);
    const restarted = manager.ensureRunning(projectPath);
    await vi.advanceTimersByTimeAsync(50);

    await shutdown;
    await expect(restarted).resolves.toBe(freshClient);
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    expect(manager.getClient(projectPath)).toBe(freshClient);
  });

  it('shuts down all tracked servers', async () => {
    const processTwo = new MockProcess(5678);
    process.kill.mockImplementation((signal?: NodeJS.Signals) => {
      process.emit('exit', 0, signal);
      return true;
    });
    processTwo.kill.mockImplementation((signal?: NodeJS.Signals) => {
      processTwo.emit('exit', 0, signal);
      return true;
    });
    const clients = [createClient('client-1'), createClient('client-2')];
    const processes = [process, processTwo];
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => processes.shift()!,
      allocatePort: vi.fn()
        .mockResolvedValueOnce(4321)
        .mockResolvedValueOnce(4322),
      createClient: () => clients.shift()!,
      healthCheck: async () => true,
    });
    await manager.ensureRunning('/tmp/project-one');
    await manager.ensureRunning('/tmp/project-two');

    await manager.shutdownAll();

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(processTwo.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('treats three consecutive periodic health failures as a crash', async () => {
    vi.useFakeTimers();
    const healthCheck = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    const manager = new ServerManager({
      stateManager,
      spawnProcess: () => process,
      allocatePort: async () => 4321,
      createClient: () => client,
      healthCheck,
      healthIntervalMs: 10,
      shutdownTimeoutMs: 1,
      now: () => 1000,
    });
    await manager.ensureRunning(projectPath);

    await vi.advanceTimersByTimeAsync(31);

    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    expect(manager.getClient(projectPath)).toBeUndefined();
    expect(stateManager.setServer).toHaveBeenLastCalledWith(projectPath, {
      port: 4321,
      pid: 1234,
      url: 'http://127.0.0.1:4321',
      startedAt: 1000,
      status: 'stopped',
    });
  });
});
