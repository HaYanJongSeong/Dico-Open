import { describe, expect, it, vi } from 'vitest';
import { BotError, ErrorCode } from '../utils/errors.js';
import {
  createChannel,
  ensureChannel,
  normalizeDiscordChannelName,
  resolveGuild,
  renameChannel,
  type DiscordAdminRest,
} from './admin.js';

function createRest(): DiscordAdminRest {
  return {
    listGuilds: vi.fn(async () => [
      { id: 'guild-1', name: 'N1zes' },
      { id: 'guild-2', name: 'Other Server' },
    ]),
    listChannels: vi.fn(async () => [
      { id: 'channel-1', guildId: 'guild-1', name: 'existing-project', type: 0 },
      { id: 'category-1', guildId: 'guild-1', name: 'Ops', type: 4 },
    ]),
    createGuildTextChannel: vi.fn(async (_guildId, name) => ({ id: 'channel-2', guildId: 'guild-1', name, type: 0 })),
    getChannel: vi.fn(async () => ({ id: 'channel-1', guildId: 'guild-1', name: 'existing-project', type: 0 })),
    updateChannelName: vi.fn(async (_channelId, name) => ({ id: 'channel-1', guildId: 'guild-1', name, type: 0 })),
  };
}

describe('Discord admin helpers', () => {
  it('normalizes channel names using Discord-style lowercase hyphenated text', () => {
    expect(normalizeDiscordChannelName(' My_Project: Agent!! ')).toBe('my-project-agent');
    expect(normalizeDiscordChannelName('Olá Mundo')).toBe('ola-mundo');
    expect(normalizeDiscordChannelName('---')).toBe('channel');
  });

  it('resolves guilds by id or normalized unique name', async () => {
    const rest = createRest();

    await expect(resolveGuild(rest, 'guild-1')).resolves.toEqual({ id: 'guild-1', name: 'N1zes' });
    await expect(resolveGuild(rest, 'n1zes')).resolves.toEqual({ id: 'guild-1', name: 'N1zes' });
  });

  it('creates a root text channel when ensureChannel does not find a normalized name match', async () => {
    const rest = createRest();

    const result = await ensureChannel(rest, { guild: 'n1zes', name: 'New Project', yes: true });

    expect(result).toEqual({ guildId: 'guild-1', channelId: 'channel-2', name: 'new-project', created: true });
    expect(rest.createGuildTextChannel).toHaveBeenCalledWith('guild-1', 'new-project');
  });

  it('returns an existing text channel when normalized names match', async () => {
    const rest = createRest();

    const result = await ensureChannel(rest, { guild: 'n1zes', name: 'Existing Project', yes: false });

    expect(result).toEqual({ guildId: 'guild-1', channelId: 'channel-1', name: 'existing-project', created: false });
    expect(rest.createGuildTextChannel).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before creating a channel', async () => {
    const rest = createRest();

    await expect(ensureChannel(rest, { guild: 'n1zes', name: 'New Project', yes: false })).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
    } satisfies Partial<BotError>);
  });

  it('refuses explicit create when a normalized duplicate exists', async () => {
    const rest = createRest();

    await expect(createChannel(rest, { guild: 'n1zes', name: 'Existing Project', yes: true })).rejects.toMatchObject({
      code: ErrorCode.DISCORD_API_ERROR,
    } satisfies Partial<BotError>);
  });

  it('renames a channel after checking for duplicate normalized names in the guild', async () => {
    const rest = createRest();

    const result = await renameChannel(rest, { channelId: 'channel-1', name: 'Renamed Project', yes: true });

    expect(result).toEqual({ channelId: 'channel-1', guildId: 'guild-1', oldName: 'existing-project', newName: 'renamed-project' });
    expect(rest.updateChannelName).toHaveBeenCalledWith('channel-1', 'renamed-project');
  });
});
