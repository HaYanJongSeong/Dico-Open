import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader, type Watcher } from './loader.js';

describe('ConfigLoader watcher', () => {
  let tmpDir: string;
  let configPath: string;

  const writeConfig = (channels: string[]): void => {
    const channelYaml = channels
      .map(
        (channelId) => `      - channelId: "${channelId}"
        projectPath: "/tmp/${channelId}"`,
      )
      .join('\n');
    const channelsBlock = channels.length === 0 ? '    channels: []' : `    channels:
${channelYaml}`;

    fs.writeFileSync(
      configPath,
      `discordToken: test-token
servers:
  - serverId: "111"
${channelsBlock}
`,
    );
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-watch-test-'));
    configPath = path.join(tmpDir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reloads config and notifies callbacks when watched file changes', async () => {
    writeConfig(['222']);
    let changeHandler: (() => void | Promise<void>) | undefined;
    const close = vi.fn().mockResolvedValue(undefined);
    const watcher: Watcher = {
      on: vi.fn((_event, handler) => {
        changeHandler = handler;
        return watcher;
      }),
      close,
    };
    const loader = new ConfigLoader(configPath);
    await loader.load();
    const callback = vi.fn();
    loader.onChange(callback);

    loader.watch({ watcherFactory: () => watcher });
    writeConfig(['333']);
    await changeHandler?.();

    expect(loader.getChannelConfig('111', '333')).toBeDefined();
    expect(loader.getChannelConfig('111', '222')).toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(loader.getConfig());
  });

  it('keeps previous config and skips callbacks when watched reload is invalid', async () => {
    writeConfig(['222']);
    let changeHandler: (() => void | Promise<void>) | undefined;
    const watcher: Watcher = {
      on: vi.fn((_event, handler) => {
        changeHandler = handler;
        return watcher;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const loader = new ConfigLoader(configPath);
    await loader.load();
    const callback = vi.fn();
    loader.onChange(callback);

    loader.watch({ watcherFactory: () => watcher });
    fs.writeFileSync(configPath, 'servers: []');
    await changeHandler?.();

    expect(loader.getChannelConfig('111', '222')).toBeDefined();
    expect(callback).not.toHaveBeenCalled();
  });

  it('calls removed-channel cleanup after successful reload removes a channel', async () => {
    writeConfig(['222', '333']);
    let changeHandler: (() => void | Promise<void>) | undefined;
    const watcher: Watcher = {
      on: vi.fn((_event, handler) => {
        changeHandler = handler;
        return watcher;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const loader = new ConfigLoader(configPath);
    await loader.load();

    loader.watch({ watcherFactory: () => watcher, onChannelRemoved: cleanup });
    writeConfig(['333']);
    await changeHandler?.();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith('111', '222', expect.objectContaining({
      channelId: '222',
      projectPath: path.resolve('/tmp/222'),
    }));
  });

  it('continues reload callbacks when removed-channel cleanup rejects', async () => {
    writeConfig(['222', '333']);
    let changeHandler: (() => void | Promise<void>) | undefined;
    const watcher: Watcher = {
      on: vi.fn((_event, handler) => {
        changeHandler = handler;
        return watcher;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValueOnce(undefined);
    const callback = vi.fn();
    const loader = new ConfigLoader(configPath);
    await loader.load();
    loader.onChange(callback);

    loader.watch({ watcherFactory: () => watcher, onChannelRemoved: cleanup });
    writeConfig([]);
    await expect(changeHandler?.()).resolves.toBeUndefined();

    expect(loader.getConfig().servers[0]!.channels).toHaveLength(0);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(loader.getConfig());
  });

  it('serializes overlapping reloads so callbacks run in source order', async () => {
    writeConfig(['222', '333']);
    let changeHandler: (() => void | Promise<void>) | undefined;
    const watcher: Watcher = {
      on: vi.fn((_event, handler) => {
        changeHandler = handler;
        return watcher;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    let resolveFirstCleanup: () => void = () => undefined;
    const firstCleanup = new Promise<void>((resolve) => {
      resolveFirstCleanup = resolve;
    });
    const cleanup = vi.fn((_: string, channelId: string) => (channelId === '222' ? firstCleanup : Promise.resolve()));
    const callbackChannels: string[][] = [];
    const loader = new ConfigLoader(configPath);
    await loader.load();
    loader.onChange((config) => {
      callbackChannels.push(config.servers[0]!.channels.map((channel) => channel.channelId));
    });

    loader.watch({ watcherFactory: () => watcher, onChannelRemoved: cleanup });
    writeConfig(['333']);
    const firstReload = changeHandler?.() ?? Promise.resolve();
    writeConfig(['444']);
    const secondReload = changeHandler?.() ?? Promise.resolve();
    await Promise.resolve();

    expect(callbackChannels).toEqual([]);

    resolveFirstCleanup();
    await Promise.all([firstReload, secondReload]);

    expect(callbackChannels).toEqual([['333'], ['444']]);
  });
});
