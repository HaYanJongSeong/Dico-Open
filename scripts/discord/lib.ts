import { ChannelType, REST, Routes } from 'discord.js';
import { ConfigLoader } from '../../src/config/loader.js';
import type { BotConfig } from '../../src/config/types.js';
import type { DiscordAdminChannel, DiscordAdminGuild, DiscordAdminRest } from '../../src/discord/admin.js';
import { BotError } from '../../src/utils/errors.js';

interface ParsedArgs {
  flags: Map<string, string>;
  yes: boolean;
}

type RawDiscordChannel = {
  id: string;
  guild_id?: string;
  name: string;
  type: number;
};

type RawDiscordGuild = {
  id: string;
  name: string;
};

/**
 * Parse simple --flag value command arguments.
 * @param argv - CLI argument slice.
 * @returns Parsed flags and confirmation flag.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  let yes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === undefined || !arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${String(arg)}`);
    }

    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    flags.set(key, value);
    index += 1;
  }

  return { flags, yes };
}

/**
 * Require a parsed CLI flag.
 * @param args - Parsed arguments.
 * @param name - Flag name without leading dashes.
 * @returns Flag value.
 */
export function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required --${name}`);
  }

  return value;
}

/**
 * Load the bot config from config.yaml.
 * @returns Validated config.
 */
export async function loadConfig(): Promise<BotConfig> {
  const loader = new ConfigLoader('config.yaml');
  await loader.load();
  return loader.getConfig();
}

/**
 * Create the Discord admin REST adapter.
 * @param token - Discord bot token.
 * @returns Discord admin REST boundary.
 */
export function createDiscordAdminRest(token: string): DiscordAdminRest {
  const rest = new REST({ version: '10' }).setToken(token);

  return {
    listGuilds: async () => {
      const guilds = await rest.get(Routes.userGuilds()) as RawDiscordGuild[];
      return guilds.map((guild) => ({ id: guild.id, name: guild.name }));
    },
    listChannels: async (guildId) => {
      const channels = await rest.get(Routes.guildChannels(guildId)) as RawDiscordChannel[];
      return channels.map((channel) => mapChannel(channel));
    },
    createGuildTextChannel: async (guildId, name) => {
      const channel = await rest.post(Routes.guildChannels(guildId), {
        body: { name, type: ChannelType.GuildText },
      }) as RawDiscordChannel;
      return mapChannel(channel, guildId);
    },
    getChannel: async (channelId) => {
      const channel = await rest.get(Routes.channel(channelId)) as RawDiscordChannel;
      return mapChannel(channel);
    },
    updateChannelName: async (channelId, name) => {
      const channel = await rest.patch(Routes.channel(channelId), { body: { name } }) as RawDiscordChannel;
      return mapChannel(channel);
    },
  };
}

/**
 * Execute a CLI script and format errors without leaking secrets.
 * @param action - Script action.
 * @returns Nothing.
 */
export async function runCli(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof BotError) {
      console.error(`${error.code}: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * Print a value as stable JSON.
 * @param value - JSON-serializable value.
 * @returns Nothing.
 */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function mapChannel(channel: RawDiscordChannel, fallbackGuildId?: string): DiscordAdminChannel {
  return {
    id: channel.id,
    guildId: channel.guild_id ?? fallbackGuildId,
    name: channel.name,
    type: channel.type,
  };
}

export type { DiscordAdminChannel, DiscordAdminGuild };
