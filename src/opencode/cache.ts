import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

/** Structural OpenCode SDK client methods used by CacheManager. */
export interface OpencodeCacheClient {
  app: {
    agents(): Promise<unknown>;
  };
  config: {
    providers(): Promise<unknown>;
  };
  v2Root?: {
    model: { list(options?: { location?: { directory?: string } }): Promise<unknown> };
  };
  session: {
    list(): Promise<unknown>;
  };
  mcp: {
    status(): Promise<unknown>;
  };
}

/** Cached OpenCode metadata for a project. */
export interface ProjectCache {
  agents: unknown[];
  models: unknown[];
  sessions: unknown[];
  mcpStatus: Record<string, unknown>;
  updatedAt: number;
}

/** Options for CacheManager construction. */
export interface CacheManagerOptions {
  cacheDir?: string;
  logger?: Pick<Logger, 'warn'>;
}

function createDefaultCache(): ProjectCache {
  return {
    agents: [],
    models: [],
    sessions: [],
    mcpStatus: {},
    updatedAt: 0,
  };
}

function cacheFilePath(cacheDir: string, projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
  return join(cacheDir, `${hash}.json`);
}

function normalizeModels(response: unknown): unknown[] {
  const unwrapped = unwrapResult(response);

  if (Array.isArray(unwrapped)) {
    return normalizeModelItems(unwrapped.flatMap((item) => isRecord(item) && Array.isArray(item.data) ? item.data : [item]));
  }

  if (isRecord(unwrapped) && Array.isArray(unwrapped.data)) {
    return normalizeModelItems(unwrapped.data);
  }

  if (isRecord(unwrapped) && 'providers' in unwrapped) {
    const providers = unwrapped.providers;
    if (Array.isArray(providers)) {
      return providers;
    }
  }

  return unwrapped === undefined || unwrapped === null ? [] : [unwrapped];
}

function normalizeModelItems(items: unknown[]): unknown[] {
  if (!items.every((item) => isRecord(item) && typeof item.providerID === 'string' && typeof item.id === 'string')) {
    return items;
  }

  const providers = new Map<string, { id: string; models: Array<{ id: string }> }>();
  for (const item of items as Array<{ providerID: string; id: string }>) {
    const provider = providers.get(item.providerID) ?? { id: item.providerID, models: [] };
    if (!provider.models.some((model) => model.id === item.id)) {
      provider.models.push({ id: item.id });
    }
    providers.set(item.providerID, provider);
  }
  return [...providers.values()];
}

function normalizeArray(response: unknown): unknown[] {
  const unwrapped = unwrapResult(response);

  if (isRecord(unwrapped) && Array.isArray(unwrapped.data)) {
    return unwrapped.data;
  }

  if (!Array.isArray(unwrapped)) {
    throw new Error('OpenCode cache response was not an array');
  }

  return unwrapped;
}

export function normalizeMcpStatus(response: unknown): Record<string, unknown> {
  const unwrapped = unwrapResult(response);

  if (!isRecord(unwrapped)) {
    throw new Error('OpenCode cache response was not an object');
  }

  if (Array.isArray(unwrapped.data)) {
    return Object.fromEntries(unwrapped.data.flatMap((item) =>
      isRecord(item) && typeof item.name === 'string' ? [[item.name, item.status]] : []));
  }

  return unwrapped;
}

function unwrapResult(response: unknown): unknown {
  if (isRecord(response) && ('data' in response || 'error' in response)) {
    if (!('data' in response) || response.data === undefined || response.data === null) {
      throw new Error('OpenCode SDK response did not include data');
    }

    return response.data;
  }

  return response;
}

function filterSessionsByProject(sessions: unknown[], projectPath: string): unknown[] {
  return sessions.filter((session) => {
    if (!isRecord(session) || typeof session.directory !== 'string') {
      return true;
    }

    return session.directory === projectPath;
  });
}

function copyCache(projectCache: ProjectCache): ProjectCache {
  return {
    agents: [...projectCache.agents],
    models: [...projectCache.models],
    sessions: [...projectCache.sessions],
    mcpStatus: { ...projectCache.mcpStatus },
    updatedAt: projectCache.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseProjectCache(value: unknown): ProjectCache | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    agents: Array.isArray(value.agents) ? [...value.agents] : [],
    models: Array.isArray(value.models) ? [...value.models] : [],
    sessions: Array.isArray(value.sessions) ? [...value.sessions] : [],
    mcpStatus: isRecord(value.mcpStatus) ? { ...value.mcpStatus } : {},
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  };
}

/** Maintains in-memory and disk-backed OpenCode autocomplete metadata. */
export class CacheManager {
  private readonly cacheDir: string;
  private readonly logger: Pick<Logger, 'warn'>;
  private readonly cache = new Map<string, ProjectCache>();
  private readonly refreshGenerations = new Map<string, number>();

  /**
   * Create an OpenCode cache manager.
   * @param options - Optional cache directory and logger
   */
  public constructor(options: CacheManagerOptions = {}) {
    this.cacheDir = options.cacheDir ?? join(process.cwd(), '.cache');
    this.logger = options.logger ?? createLogger('CacheManager');
  }

  /**
   * Refresh cached metadata for a project from the OpenCode SDK client.
   * @param projectPath - Project path used as the cache key
   * @param client - OpenCode SDK client with cacheable metadata methods
   * @returns Nothing
   */
  public async refresh(projectPath: string, client: OpencodeCacheClient): Promise<void> {
    const generation = (this.refreshGenerations.get(projectPath) ?? 0) + 1;
    this.refreshGenerations.set(projectPath, generation);
    const previous = this.getOrLoad(projectPath);
    const next: ProjectCache = {
      agents: await this.fetchOrDefault(
        'agents',
        projectPath,
        async () => normalizeArray(await client.app.agents()),
        previous.agents,
      ),
      models: await this.fetchOrDefault(
        'models',
        projectPath,
        async () => normalizeModels(await (client.v2Root?.model.list({ location: { directory: projectPath } }) ?? client.config.providers())),
        previous.models,
      ),
      sessions: await this.fetchOrDefault(
        'sessions',
        projectPath,
        async () => filterSessionsByProject(normalizeArray(await client.session.list()), projectPath),
        previous.sessions,
      ),
      mcpStatus: await this.fetchOrDefault(
        'mcpStatus',
        projectPath,
        async () => normalizeMcpStatus(await client.mcp.status()),
        previous.mcpStatus,
      ),
      updatedAt: Date.now(),
    };

    if (this.refreshGenerations.get(projectPath) === generation) {
      this.cache.set(projectPath, next);
      this.write(projectPath, next);
    }
  }

  /**
   * Get cached agents for a project.
   * @param projectPath - Project path used as the cache key
   * @returns Cached agents or an empty array on cache miss
   */
  public getAgents(projectPath: string): unknown[] {
    return [...this.getOrLoad(projectPath).agents];
  }

  /**
   * Get cached models/providers for a project.
   * @param projectPath - Project path used as the cache key
   * @returns Cached models or an empty array on cache miss
   */
  public getModels(projectPath: string): unknown[] {
    return [...this.getOrLoad(projectPath).models];
  }

  /**
   * Get cached sessions for a project.
   * @param projectPath - Project path used as the cache key
   * @returns Cached sessions or an empty array on cache miss
   */
  public getSessions(projectPath: string): unknown[] {
    return [...this.getOrLoad(projectPath).sessions];
  }

  /**
   * Get cached MCP status for a project.
   * @param projectPath - Project path used as the cache key
   * @returns Cached MCP status or an empty object on cache miss
   */
  public getMcpStatus(projectPath: string): Record<string, unknown> {
    return { ...this.getOrLoad(projectPath).mcpStatus };
  }

  private async fetchOrDefault<T>(
    field: string,
    projectPath: string,
    fetchValue: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await fetchValue();
    } catch (error) {
      this.logger.warn('OpenCode 캐시 갱신 실패', {
        field,
        projectPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  private getOrLoad(projectPath: string): ProjectCache {
    const cached = this.cache.get(projectPath);
    if (cached !== undefined) {
      return cached;
    }

    const loaded = this.load(projectPath) ?? createDefaultCache();
    this.cache.set(projectPath, loaded);
    return copyCache(loaded);
  }

  private load(projectPath: string): ProjectCache | undefined {
    const filePath = cacheFilePath(this.cacheDir, projectPath);
    if (!existsSync(filePath)) {
      return undefined;
    }

    try {
      return parseProjectCache(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch (error) {
      this.logger.warn('OpenCode cache read failed', { projectPath, error });
      return undefined;
    }
  }

  private write(projectPath: string, projectCache: ProjectCache): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const filePath = cacheFilePath(this.cacheDir, projectPath);
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify(projectCache), 'utf8');
      renameSync(temporaryPath, filePath);
    } catch (error) {
      this.logger.warn('OpenCode cache write failed', { projectPath, error });
    }
  }
}
