import { BotError, ErrorCode } from '../utils/errors.js';

const TEXT_CHANNEL_TYPE = 0;

/** Minimal guild information needed for Discord admin scripts. */
export interface DiscordAdminGuild {
  id: string;
  name: string;
}

/** Minimal channel information needed for Discord admin scripts. */
export interface DiscordAdminChannel {
  id: string;
  guildId?: string;
  name: string;
  type: number;
}

/** Narrow Discord REST boundary used by admin helpers. */
export interface DiscordAdminRest {
  listGuilds(): Promise<DiscordAdminGuild[]>;
  listChannels(guildId: string): Promise<DiscordAdminChannel[]>;
  createGuildTextChannel(guildId: string, name: string): Promise<DiscordAdminChannel>;
  getChannel(channelId: string): Promise<DiscordAdminChannel>;
  updateChannelName(channelId: string, name: string): Promise<DiscordAdminChannel>;
}

/** Result returned when creating or ensuring a Discord channel. */
export interface EnsureChannelResult {
  guildId: string;
  channelId: string;
  name: string;
  created: boolean;
}

/** Result returned when renaming a Discord channel. */
export interface RenameChannelResult {
  channelId: string;
  guildId: string;
  oldName: string;
  newName: string;
}

/**
 * Normalize arbitrary text into a Discord-compatible channel name.
 * @param name - Human-provided channel name.
 * @returns Lowercase hyphenated channel name, or "channel" when empty after normalization.
 */
export function normalizeDiscordChannelName(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return normalized.length > 0 ? normalized.slice(0, 100) : 'channel';
}

/**
 * Resolve a Discord guild by exact ID or normalized unique name.
 * @param rest - Discord REST boundary.
 * @param guild - Guild ID or name.
 * @returns Matching guild.
 */
export async function resolveGuild(rest: DiscordAdminRest, guild: string): Promise<DiscordAdminGuild> {
  const guilds = await rest.listGuilds();
  const byId = guilds.find((item) => item.id === guild);
  if (byId !== undefined) {
    return byId;
  }

  const normalized = normalizeLookupName(guild);
  const matches = guilds.filter((item) => normalizeLookupName(item.name) === normalized);
  if (matches.length === 1) {
    return matches[0]!;
  }

  if (matches.length > 1) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Discord guild name is ambiguous: ${guild}`, {
      guild,
      matches: matches.map((item) => ({ id: item.id, name: item.name })),
    });
  }

  throw new BotError(ErrorCode.DISCORD_API_ERROR, `Discord guild not found: ${guild}`, { guild });
}

/**
 * Ensure a root text channel exists in a guild.
 * @param rest - Discord REST boundary.
 * @param options - Guild, channel name, and confirmation flag.
 * @returns Existing or created channel metadata.
 */
export async function ensureChannel(
  rest: DiscordAdminRest,
  options: { guild: string; name: string; yes: boolean },
): Promise<EnsureChannelResult> {
  const guild = await resolveGuild(rest, options.guild);
  const name = normalizeDiscordChannelName(options.name);
  const existing = await findTextChannelByName(rest, guild.id, name);
  if (existing !== undefined) {
    return { guildId: guild.id, channelId: existing.id, name: existing.name, created: false };
  }

  requireYes(options.yes, 'Creating a Discord channel requires --yes.');
  const created = await rest.createGuildTextChannel(guild.id, name);
  return { guildId: guild.id, channelId: created.id, name: created.name, created: true };
}

/**
 * Create a root text channel, refusing normalized duplicates.
 * @param rest - Discord REST boundary.
 * @param options - Guild, channel name, and confirmation flag.
 * @returns Created channel metadata.
 */
export async function createChannel(
  rest: DiscordAdminRest,
  options: { guild: string; name: string; yes: boolean },
): Promise<EnsureChannelResult> {
  const guild = await resolveGuild(rest, options.guild);
  const name = normalizeDiscordChannelName(options.name);
  const existing = await findTextChannelByName(rest, guild.id, name);
  if (existing !== undefined) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Discord channel already exists: ${name}`, {
      guildId: guild.id,
      channelId: existing.id,
      name,
    });
  }

  requireYes(options.yes, 'Creating a Discord channel requires --yes.');
  const created = await rest.createGuildTextChannel(guild.id, name);
  return { guildId: guild.id, channelId: created.id, name: created.name, created: true };
}

/**
 * Rename a text channel after duplicate-name validation in the same guild.
 * @param rest - Discord REST boundary.
 * @param options - Channel ID, target name, and confirmation flag.
 * @returns Rename metadata.
 */
export async function renameChannel(
  rest: DiscordAdminRest,
  options: { channelId: string; name: string; yes: boolean },
): Promise<RenameChannelResult> {
  requireYes(options.yes, 'Renaming a Discord channel requires --yes.');
  const channel = await rest.getChannel(options.channelId);
  if (channel.guildId === undefined) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Discord channel has no guild: ${options.channelId}`, { channelId: options.channelId });
  }
  if (channel.type !== TEXT_CHANNEL_TYPE) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Discord channel is not a text channel: ${options.channelId}`, { channelId: options.channelId });
  }

  const newName = normalizeDiscordChannelName(options.name);
  const duplicate = (await rest.listChannels(channel.guildId))
    .filter((item) => item.type === TEXT_CHANNEL_TYPE && item.id !== options.channelId)
    .find((item) => normalizeDiscordChannelName(item.name) === newName);
  if (duplicate !== undefined) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, `Discord channel already exists: ${newName}`, {
      guildId: channel.guildId,
      channelId: duplicate.id,
      name: newName,
    });
  }

  await rest.updateChannelName(options.channelId, newName);
  return { channelId: options.channelId, guildId: channel.guildId, oldName: channel.name, newName };
}

async function findTextChannelByName(rest: DiscordAdminRest, guildId: string, name: string): Promise<DiscordAdminChannel | undefined> {
  const channels = await rest.listChannels(guildId);
  return channels
    .filter((channel) => channel.type === TEXT_CHANNEL_TYPE)
    .find((channel) => normalizeDiscordChannelName(channel.name) === name);
}

function normalizeLookupName(name: string): string {
  return normalizeDiscordChannelName(name);
}

function requireYes(yes: boolean, message: string): void {
  if (!yes) {
    throw new BotError(ErrorCode.PERMISSION_DENIED, message);
  }
}
