import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from './loader.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('ConfigLoader', () => {
  let tmpDir: string;
  let configPath: string;

  const validYaml = `
discordToken: test-token
servers:
  - serverId: "111"
    channels:
      - channelId: "222"
        projectPath: "/tmp/project"
`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    configPath = path.join(tmpDir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and validates a config file', async () => {
    fs.writeFileSync(configPath, validYaml);
    const loader = new ConfigLoader(configPath);
    await loader.load();
    const config = loader.getConfig();
    expect(config.discordToken).toBe('test-token');
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]!.channels[0]!.channelId).toBe('222');
  });

  it('throws BotError on invalid YAML', async () => {
    fs.writeFileSync(configPath, 'invalid: [unclosed');
    const loader = new ConfigLoader(configPath);
    await expect(loader.load()).rejects.toThrow();
  });

  it('throws BotError on schema validation failure', async () => {
    fs.writeFileSync(configPath, 'servers: []');
    const loader = new ConfigLoader(configPath);
    await expect(loader.load()).rejects.toThrow();
  });

  it('throws BotError when getConfig is called before load', () => {
    const loader = new ConfigLoader(configPath);

    expect(() => loader.getConfig()).toThrow(BotError);

    try {
      loader.getConfig();
    } catch (err) {
      expect(err).toBeInstanceOf(BotError);
      expect((err as BotError).code).toBe(ErrorCode.CONFIG_INVALID);
    }
  });

  it('getChannelConfig returns config for known channel', async () => {
    fs.writeFileSync(configPath, validYaml);
    const loader = new ConfigLoader(configPath);
    await loader.load();
    const channel = loader.getChannelConfig('111', '222');
    expect(channel).toBeDefined();
    expect(channel!.projectPath).toBe(path.resolve('/tmp/project'));
  });

  it('resolves relative projectPath values from the config file directory', async () => {
    fs.writeFileSync(configPath, `
discordToken: test-token
servers:
  - serverId: "111"
    channels:
      - channelId: "222"
        projectPath: "../project"
`);
    const loader = new ConfigLoader(configPath);

    await loader.load();

    const channel = loader.getChannelConfig('111', '222');
    expect(channel!.projectPath).toBe(path.resolve(tmpDir, '../project'));
  });

  it('resolves home-relative projectPath values from the current user home directory', async () => {
    fs.writeFileSync(configPath, `
discordToken: test-token
servers:
  - serverId: "111"
    channels:
      - channelId: "222"
        projectPath: "~/Developer/project"
`);
    const loader = new ConfigLoader(configPath);

    await loader.load();

    const channel = loader.getChannelConfig('111', '222');
    expect(channel!.projectPath).toBe(path.join(os.homedir(), 'Developer/project'));
  });

  it('getChannelConfig returns undefined for unknown channel', async () => {
    fs.writeFileSync(configPath, validYaml);
    const loader = new ConfigLoader(configPath);
    await loader.load();
    const channel = loader.getChannelConfig('111', '999');
    expect(channel).toBeUndefined();
  });

  it('emits onChange callback when config reloaded', async () => {
    fs.writeFileSync(configPath, validYaml);
    const loader = new ConfigLoader(configPath);
    await loader.load();
    const callback = vi.fn();
    loader.onChange(callback);
    await loader.load();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
