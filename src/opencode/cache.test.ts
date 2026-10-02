import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheManager } from './cache.js';
import type { OpencodeCacheClient } from './cache.js';

function createCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'opencode-cache-test-'));
}

function createClient(overrides: Partial<OpencodeCacheClient> = {}): OpencodeCacheClient {
  return {
    app: {
      agents: vi.fn(async () => [{ name: 'build' }]),
      ...overrides.app,
    },
    config: {
      providers: vi.fn(async () => ({ providers: [{ id: 'anthropic' }] })),
      ...overrides.config,
    },
    session: {
      list: vi.fn(async () => [{ id: 'session-1' }]),
      ...overrides.session,
    },
    mcp: {
      status: vi.fn(async () => ({ filesystem: { status: 'connected' } })),
      ...overrides.mcp,
    },
  };
}

describe('CacheManager', () => {
  const projectPath = '/tmp/opencode-project';
  const cacheDirs: string[] = [];

  afterEach(() => {
    for (const cacheDir of cacheDirs) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
    cacheDirs.length = 0;
  });

  it('refreshes agents, models, sessions, and MCP status from the SDK client', async () => {
    const cacheDir = createCacheDir();
    cacheDirs.push(cacheDir);
    const manager = new CacheManager({ cacheDir });
    const client = createClient();

    await manager.refresh(projectPath, client);

    expect(client.app.agents).toHaveBeenCalledTimes(1);
    expect(client.config.providers).toHaveBeenCalledTimes(1);
    expect(client.session.list).toHaveBeenCalledTimes(1);
    expect(client.mcp.status).toHaveBeenCalledTimes(1);
    expect(manager.getAgents(projectPath)).toEqual([{ name: 'build' }]);
    expect(manager.getModels(projectPath)).toEqual([{ id: 'anthropic' }]);
    expect(manager.getSessions(projectPath)).toEqual([{ id: 'session-1' }]);
    expect(manager.getMcpStatus(projectPath)).toEqual({ filesystem: { status: 'connected' } });
  });

  it('unwraps OpenCode SDK result data before caching', async () => {
    const cacheDir = createCacheDir();
    cacheDirs.push(cacheDir);
    const manager = new CacheManager({ cacheDir });
    const client = createClient({
      app: { agents: vi.fn(async () => ({ data: [{ name: 'build' }] })) },
      config: { providers: vi.fn(async () => ({ data: { providers: [{ id: 'anthropic' }] } })) },
      session: { list: vi.fn(async () => ({ data: [{ id: 'session-1' }] })) },
      mcp: { status: vi.fn(async () => ({ data: { location: { directory: projectPath }, data: [{ name: 'qgis', status: { status: 'connected' } }] } })) },
    });

    await manager.refresh(projectPath, client);

    expect(manager.getAgents(projectPath)).toEqual([{ name: 'build' }]);
    expect(manager.getModels(projectPath)).toEqual([{ id: 'anthropic' }]);
    expect(manager.getSessions(projectPath)).toEqual([{ id: 'session-1' }]);
    expect(manager.getMcpStatus(projectPath)).toEqual({ qgis: { status: 'connected' } });
  });

  it('filters cached sessions to the refreshed project path', async () => {
    const cacheDir = createCacheDir();
    cacheDirs.push(cacheDir);
    const manager = new CacheManager({ cacheDir });
    const client = createClient({
      session: {
        list: vi.fn(async () => [
          { id: 'current-session', directory: projectPath },
          { id: 'other-session', directory: '/tmp/other-project' },
          { id: 'legacy-session' },
        ]),
      },
    });

    await manager.refresh(projectPath, client);

    expect(manager.getSessions(projectPath)).toEqual([
      { id: 'current-session', directory: projectPath },
      { id: 'legacy-session' },
    ]);
  });

  it('persists refreshed cache to disk and loads it in a new manager', async () => {
    const cacheDir = createCacheDir();
    cacheDirs.push(cacheDir);
    const firstManager = new CacheManager({ cacheDir });
    await firstManager.refresh(projectPath, createClient());

    const secondManager = new CacheManager({ cacheDir });

    expect(secondManager.getAgents(projectPath)).toEqual([{ name: 'build' }]);
    expect(secondManager.getModels(projectPath)).toEqual([{ id: 'anthropic' }]);
    expect(secondManager.getSessions(projectPath)).toEqual([{ id: 'session-1' }]);
    expect(secondManager.getMcpStatus(projectPath)).toEqual({ filesystem: { status: 'connected' } });
  });

  it('returns empty values for a cold cache', () => {
    const cacheDir = createCacheDir();
    cacheDirs.push(cacheDir);
    const manager = new CacheManager({ cacheDir });

    expect(manager.getAgents(projectPath)).toEqual([]);
    expect(manager.getModels(projectPath)).toEqual([]);
    expect(manager.getSessions(projectPath)).toEqual([]);
    expect(manager.getMcpStatus(projectPath)).toEqual({});
  });

  it('does not share cold-cache defaults between projects through getter mutation', () => {
    const cacheDir = createCacheDir();
    cacheDirs.push(cacheDir);
    const manager = new CacheManager({ cacheDir });

    manager.getAgents('/project-a').push({ name: 'mutated' });

    expect(manager.getAgents('/project-a')).toEqual([]);
    expect(manager.getAgents('/project-b')).toEqual([]);
  });

  it('keeps old values or defaults when a refresh fetch fails', async () => {
    const cacheDir = createCacheDir();
    cacheDirs.push(cacheDir);
    const manager = new CacheManager({ cacheDir });
    await manager.refresh(projectPath, createClient());
    const warningLogger = { warn: vi.fn() };
    const failingManager = new CacheManager({ cacheDir, logger: warningLogger });

    await failingManager.refresh(projectPath, createClient({
      app: { agents: vi.fn(async () => { throw new Error('agent fetch failed'); }) },
      mcp: { status: vi.fn(async () => { throw new Error('mcp fetch failed'); }) },
    }));

    expect(failingManager.getAgents(projectPath)).toEqual([{ name: 'build' }]);
    expect(failingManager.getModels(projectPath)).toEqual([{ id: 'anthropic' }]);
    expect(failingManager.getSessions(projectPath)).toEqual([{ id: 'session-1' }]);
    expect(failingManager.getMcpStatus(projectPath)).toEqual({ filesystem: { status: 'connected' } });
    expect(warningLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('does not let an older overlapping refresh overwrite newer metadata', async () => {
    const cacheDir = createCacheDir();
    cacheDirs.push(cacheDir);
    const manager = new CacheManager({ cacheDir });
    let resolveOldAgents: (agents: unknown[]) => void = () => undefined;
    const oldAgents = new Promise<unknown[]>((resolve) => {
      resolveOldAgents = resolve;
    });
    const oldClient = createClient({
      app: { agents: vi.fn(async () => await oldAgents) },
    });
    const newClient = createClient({
      app: { agents: vi.fn(async () => [{ name: 'new' }]) },
    });

    const olderRefresh = manager.refresh(projectPath, oldClient);
    await manager.refresh(projectPath, newClient);
    resolveOldAgents([{ name: 'old' }]);
    await olderRefresh;

    expect(manager.getAgents(projectPath)).toEqual([{ name: 'new' }]);
  });
});
