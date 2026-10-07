import { describe, it, expect } from 'vitest';
import { configSchema } from './schema.js';

const validConfig = {
  discordToken: 'test-token-123',
  servers: [
    {
      serverId: '111111111111111111',
      channels: [
        {
          channelId: '222222222222222222',
          projectPath: '/Users/test/project',
        },
      ],
    },
  ],
};

describe('configSchema', () => {
  it('validates a minimal valid config', () => {
    const result = configSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it('applies defaults for optional channel fields', () => {
    const result = configSchema.parse(validConfig);
    const channel = result.servers[0]!.channels[0]!;
    expect(channel.model).toBeUndefined();
    expect(channel.allowAgentSwitch).toBe(true);
    expect(channel.allowedAgents).toEqual([]);
    expect(channel.allowedUsers).toEqual([]);
    expect(channel.permissions).toBe('auto');
    expect(channel.questionTimeout).toBe(300);
    expect(channel.connectHistoryLimit).toBe(30);
    expect(channel.autoConnect).toBe(false);
    expect(channel.autoConnectSince).toBeUndefined();
  });

  it('rejects config without discordToken', () => {
    const result = configSchema.safeParse({ servers: [] });
    expect(result.success).toBe(false);
  });

  it.each(['2026-10-06T15:00:00Z', '2026-10-07T00:00:00+09:00'])('preserves an ISO autoConnectSince: %s', (autoConnectSince) => {
    const result = configSchema.parse({
      ...validConfig,
      servers: [{ serverId: '111', channels: [{ channelId: '222', projectPath: '/path', autoConnectSince }] }],
    });
    expect(result.servers[0]!.channels[0]!.autoConnectSince).toBe(autoConnectSince);
  });

  it.each(['', 'today', '2026-10-07', '2026-10-07T00:00:00', '2026-02-30T00:00:00Z', 123])('rejects an invalid autoConnectSince: %s', (autoConnectSince) => {
    expect(configSchema.safeParse({
      ...validConfig,
      servers: [{ serverId: '111', channels: [{ channelId: '222', projectPath: '/path', autoConnectSince }] }],
    }).success).toBe(false);
  });

  it('rejects config without servers', () => {
    const result = configSchema.safeParse({ discordToken: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects empty serverId', () => {
    const result = configSchema.safeParse({
      discordToken: 'x',
      servers: [{ serverId: '', channels: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative connectHistoryLimit', () => {
    const config = structuredClone(validConfig);
    config.servers[0]!.channels[0] = {
      ...config.servers[0]!.channels[0]!,
      connectHistoryLimit: -1,
    } as any;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects invalid permissions value', () => {
    const config = structuredClone(validConfig);
    config.servers[0]!.channels[0] = {
      ...config.servers[0]!.channels[0]!,
      permissions: 'invalid',
    } as any;
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('accepts full config with all optional fields', () => {
    const fullConfig = {
      discordToken: 'token',
      servers: [
        {
          serverId: '111',
          channels: [
            {
              channelId: '222',
              projectPath: '/path',
              defaultAgent: 'code',
              model: 'google/gemini-3.5-flash',
              allowAgentSwitch: false,
              allowedAgents: ['code', 'build'],
              allowedUsers: ['user1'],
              permissions: 'interactive',
              questionTimeout: 60,
              connectHistoryLimit: 5,
              autoConnect: true,
            },
          ],
        },
      ],
    };
    const result = configSchema.safeParse(fullConfig);
    expect(result.success).toBe(true);
  });

  it('preserves the optional channel model', () => {
    const config = structuredClone(validConfig);
    config.servers[0]!.channels[0] = {
      ...config.servers[0]!.channels[0]!,
      model: 'google/gemini-3.5-flash',
    } as any;

    const result = configSchema.parse(config);

    expect(result.servers[0]!.channels[0]!.model).toBe('google/gemini-3.5-flash');
  });
});
