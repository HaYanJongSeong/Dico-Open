import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createDiscordClient } from './client.js';

describe('createDiscordClient', () => {
  it('returns a configured Discord client without logging in', () => {
    const client = createDiscordClient('test-token');

    expect(client).toBeInstanceOf(Client);
    expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildMessageTyping)).toBe(true);
    expect(client.options.partials).toEqual([
      Partials.Channel,
      Partials.Message,
      Partials.ThreadMember,
    ]);
    expect(client.token).toBeNull();
  });
});
