import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { watch as chokidarWatch } from 'chokidar';
import { parse as parseYaml } from 'yaml';
import { configSchema, type ValidatedConfig } from './schema.js';
import type { ChannelConfig } from './types.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ConfigLoader');

function resolveProjectPath(projectPath: string, configDirectory: string): string {
  if (projectPath === '~') {
    return os.homedir();
  }

  if (/^~[\\/]/u.test(projectPath)) {
    return path.join(os.homedir(), projectPath.slice(2));
  }

  return path.resolve(configDirectory, projectPath);
}

function resolveProjectPaths(config: ValidatedConfig, configPath: string): ValidatedConfig {
  const configDirectory = path.dirname(path.resolve(configPath));

  return {
    ...config,
    servers: config.servers.map((server) => ({
      ...server,
      channels: server.channels.map((channel) => ({
        ...channel,
        projectPath: resolveProjectPath(channel.projectPath, configDirectory),
      })),
    })),
  };
}

/** Callback invoked after a config reload succeeds. */
export type ChangeCallback = (config: ValidatedConfig) => void;

/** Callback invoked when a successful reload removes a channel mapping. */
export type ChannelRemovedCallback = (
  guildId: string,
  channelId: string,
  channelConfig: ChannelConfig,
) => Promise<void> | void;

/** Minimal watcher interface used by ConfigLoader. */
export interface Watcher {
  on(event: 'change', callback: () => Promise<void> | void): Watcher;
  close(): Promise<void> | void;
}

/** Factory used to create a file watcher. */
export type WatcherFactory = (configPath: string) => Watcher;

/** Options for config file hot-reload watching. */
export interface WatchOptions {
  onChannelRemoved?: ChannelRemovedCallback;
  watcherFactory?: WatcherFactory;
}

/** Loads, validates, and exposes bot configuration from a YAML file. */
export class ConfigLoader {
  private config: ValidatedConfig | null = null;
  private readonly callbacks: ChangeCallback[] = [];
  private watcher: Watcher | null = null;
  private reloadQueue: Promise<void> | null = null;

  /**
   * Create a config loader for a YAML file path.
   * @param configPath - Path to the YAML config file
   */
  public constructor(private readonly configPath: string) {}

  /**
   * Load and validate the config file.
   * @returns Nothing
   * @throws BotError with CONFIG_INVALID if reading, YAML parsing, or validation fails
   */
  public async load(): Promise<void> {
    const parsedConfig = this.readConfig();

    this.config = parsedConfig;
    logger.info('설정 로드 완료', { servers: parsedConfig.servers.length });

    for (const callback of this.callbacks) {
      callback(parsedConfig);
    }
  }

  private readConfig(): ValidatedConfig {
    let raw: string;

    try {
      raw = fs.readFileSync(this.configPath, 'utf-8');
    } catch (err) {
      throw new BotError(ErrorCode.CONFIG_INVALID, `Cannot read config file: ${this.configPath}`, {
        path: this.configPath,
        error: String(err),
      });
    }

    let parsed: unknown;

    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new BotError(ErrorCode.CONFIG_INVALID, 'Invalid YAML in config file', {
        path: this.configPath,
        error: String(err),
      });
    }

    const result = configSchema.safeParse(parsed);

    if (!result.success) {
      throw new BotError(ErrorCode.CONFIG_INVALID, `Config validation failed: ${result.error.message}`, {
        path: this.configPath,
        errors: result.error.issues,
      });
    }

    return resolveProjectPaths(result.data, this.configPath);
  }

  /**
   * Get the current validated config.
   * @returns The validated bot config
   * @throws BotError with CONFIG_INVALID if config has not been loaded yet
   */
  public getConfig(): ValidatedConfig {
    if (!this.config) {
      throw new BotError(ErrorCode.CONFIG_INVALID, 'Config not loaded yet');
    }

    return this.config;
  }

  /**
   * Look up a channel config by guild and channel ID.
   * @param guildId - Discord guild/server ID
   * @param channelId - Discord channel ID
   * @returns Matching channel config, or undefined if not found
   */
  public getChannelConfig(guildId: string, channelId: string): ChannelConfig | undefined {
    if (!this.config) {
      return undefined;
    }

    const server = this.config.servers.find((item) => item.serverId === guildId);

    return server?.channels.find((channel) => channel.channelId === channelId);
  }

  /**
   * Register a callback for subsequent config reloads.
   * @param callback - Function called with the validated config after each load
   * @returns Nothing
   */
  public onChange(callback: ChangeCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Watch the config file and hot-reload successful changes.
   * @param options - Optional callbacks and watcher factory for hot-reload behavior
   * @returns Nothing
   */
  public watch(options: WatchOptions = {}): void {
    if (this.watcher) {
      return;
    }

    const watcherFactory = options.watcherFactory ?? chokidarWatch;
    this.watcher = watcherFactory(this.configPath);
    this.watcher.on('change', async () => {
      await this.queueReloadFromWatcher(options.onChannelRemoved);
    });
  }

  /**
   * Stop watching the config file.
   * @returns Nothing
   */
  public async close(): Promise<void> {
    if (!this.watcher) {
      return;
    }

    await this.watcher.close();
    this.watcher = null;
  }

  private queueReloadFromWatcher(onChannelRemoved?: ChannelRemovedCallback): Promise<void> {
    if (!this.reloadQueue) {
      let queued: Promise<void>;
      queued = this.reloadFromWatcher(onChannelRemoved).finally(() => {
        if (this.reloadQueue === queued) {
          this.reloadQueue = null;
        }
      });
      this.reloadQueue = queued;
      return queued;
    }

    let queued: Promise<void>;
    queued = this.reloadQueue
      .catch(() => undefined)
      .then(() => this.reloadFromWatcher(onChannelRemoved))
      .finally(() => {
        if (this.reloadQueue === queued) {
          this.reloadQueue = null;
        }
      });
    this.reloadQueue = queued;
    return queued;
  }

  private async reloadFromWatcher(onChannelRemoved?: ChannelRemovedCallback): Promise<void> {
    const previousConfig = this.config;
    let nextConfig: ValidatedConfig;

    try {
      nextConfig = this.readConfig();
    } catch (err) {
      const context = err instanceof BotError ? err.context : { error: String(err) };
      logger.warn('설정 변경 거부', {
        code: ErrorCode.CONFIG_INVALID,
        path: this.configPath,
        ...context,
      });
      return;
    }

    this.config = nextConfig;
    logger.info('설정 변경 반영 완료', { servers: nextConfig.servers.length });

    if (previousConfig && onChannelRemoved) {
      await this.notifyRemovedChannels(previousConfig, nextConfig, onChannelRemoved);
    }

    for (const callback of this.callbacks) {
      callback(nextConfig);
    }
  }

  private async notifyRemovedChannels(
    previousConfig: ValidatedConfig,
    nextConfig: ValidatedConfig,
    onChannelRemoved: ChannelRemovedCallback,
  ): Promise<void> {
    for (const server of previousConfig.servers) {
      for (const channel of server.channels) {
        const stillConfigured = nextConfig.servers.some(
          (nextServer) => nextServer.serverId === server.serverId
            && nextServer.channels.some((nextChannel) => nextChannel.channelId === channel.channelId),
        );

        if (!stillConfigured) {
          try {
            await onChannelRemoved(server.serverId, channel.channelId, channel);
          } catch (err) {
            logger.warn('Removed-channel cleanup failed during config hot-reload', {
              guildId: server.serverId,
              channelId: channel.channelId,
              error: String(err),
            });
          }
        }
      }
    }
  }
}
