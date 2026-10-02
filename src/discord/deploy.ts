import { REST, Routes, type SlashCommandBuilder } from 'discord.js';
import { BotError, ErrorCode } from '../utils/errors.js';

function decodeApplicationId(token: string): string {
  const [encodedApplicationId] = token.split('.');

  if (!encodedApplicationId) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Discord bot token is missing application ID');
  }

  try {
    const applicationId = Buffer.from(encodedApplicationId, 'base64url').toString('utf8');

    if (!/^\d+$/.test(applicationId)) {
      throw new Error('Decoded application ID is not a Discord snowflake');
    }

    return applicationId;
  } catch (error) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Failed to decode Discord application ID', {
      cause: error,
    });
  }
}

/**
 * Deploys slash commands to a Discord guild.
 *
 * @param token - Discord bot token whose first segment encodes the application ID.
 * @param guildId - Discord guild ID to register commands for.
 * @param commands - Slash command builders to register.
 * @returns Resolves after Discord accepts the registration request.
 */
export async function deployCommands(
  token: string,
  guildId: string,
  commands: SlashCommandBuilder[],
): Promise<void> {
  const applicationId = decodeApplicationId(token);
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
      body: commands.map((command) => command.toJSON()),
    });
  } catch (error) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Failed to deploy Discord commands', {
      cause: error,
    });
  }
}
