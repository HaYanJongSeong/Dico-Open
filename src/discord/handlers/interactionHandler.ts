import type {
  ApplicationCommandOptionChoiceData,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Interaction,
  InteractionReplyOptions,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { ConfigLoader } from '../../config/loader.js';
import type { ChannelConfig } from '../../config/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { createLogger, generateCorrelationId } from '../../utils/logger.js';
import { checkUserAllowed } from '../../utils/permissions.js';
import { suppressLinkPreviews } from '../messageOptions.js';

const logger = createLogger('InteractionHandler');

/** Context passed to interaction sub-handlers. */
export interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

/**
 * Executes a chat input command interaction.
 * @param interaction - Discord chat input command interaction
 * @param context - Per-interaction context including correlation ID and channel config
 * @returns Nothing
 */
export type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  context: InteractionContext,
) => Promise<void>;

/**
 * Resolves autocomplete choices for an interaction.
 * @param interaction - Discord autocomplete interaction
 * @param context - Per-interaction context including correlation ID and channel config
 * @returns Autocomplete choices to send to Discord
 */
export type AutocompleteHandler = (
  interaction: AutocompleteInteraction,
  context: InteractionContext,
) => Promise<ApplicationCommandOptionChoiceData[]>;

/** Options for the Discord interaction router. */
export interface InteractionHandlerOptions {
  configLoader: ConfigLoader;
  commandHandlers: Map<string, CommandHandler>;
  autocompleteHandler: AutocompleteHandler;
}

/**
 * Route supported Discord interactions to command or autocomplete handlers.
 * @param interaction - Incoming Discord interaction
 * @param options - Router dependencies and registered handlers
 * @returns Nothing
 */
export async function handleInteraction(
  interaction: Interaction,
  options: InteractionHandlerOptions,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await handleCommandInteraction(interaction, options);
    return;
  }

  if (interaction.isAutocomplete()) {
    await handleAutocompleteInteraction(interaction, options);
  }
}

async function handleCommandInteraction(
  interaction: ChatInputCommandInteraction,
  options: InteractionHandlerOptions,
): Promise<void> {
  const context = createContext(interaction, options.configLoader);
  logger.info('Command interaction received', {
    commandName: interaction.commandName,
    correlationId: context.correlationId,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
  });

  try {
    if (context.channelConfig && !checkUserAllowed(context.channelConfig, interaction.user.id)) {
      throw new BotError(ErrorCode.PERMISSION_DENIED, 'You are not allowed to use this bot in this channel.');
    }

    const handler = options.commandHandlers.get(interaction.commandName);

    if (!handler) {
      throw new BotError(ErrorCode.DISCORD_API_ERROR, `Unknown command: ${interaction.commandName}`);
    }

    await handler(interaction, context);
  } catch (err) {
    await sendError(interaction, err, context.correlationId);
  }
}

async function handleAutocompleteInteraction(
  interaction: AutocompleteInteraction,
  options: InteractionHandlerOptions,
): Promise<void> {
  const context = createContext(interaction, options.configLoader);
  logger.info('Autocomplete interaction received', {
    commandName: interaction.commandName,
    correlationId: context.correlationId,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
  });

  try {
    if (context.channelConfig && !checkUserAllowed(context.channelConfig, interaction.user.id)) {
      await interaction.respond([]);
      return;
    }
    const choices = await options.autocompleteHandler(interaction, context);
    logger.info('Autocomplete choices resolved', {
      commandName: interaction.commandName,
      correlationId: context.correlationId,
      choiceCount: choices.length,
    });
    await interaction.respond(choices.slice(0, 25));
    logger.info('Autocomplete response sent', {
      commandName: interaction.commandName,
      correlationId: context.correlationId,
      choiceCount: Math.min(choices.length, 25),
    });
  } catch (err) {
    logger.warn('Autocomplete handler failed', { commandName: interaction.commandName, correlationId: context.correlationId, err });
    await respondSafely(interaction, [], context.correlationId);
  }
}

function createContext(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
  configLoader: ConfigLoader,
): InteractionContext {
  const correlationId = generateCorrelationId(interaction.channelId ?? interaction.id);
  const channel = interaction.channel as { parentId?: string | null; isThread?: () => boolean } | null;
  const channelId = channel?.isThread?.() === true
    ? channel.parentId ?? interaction.channelId
    : interaction.channelId;
  const channelConfig = interaction.guildId
    ? configLoader.getChannelConfig(interaction.guildId, channelId)
    : undefined;

  return { correlationId, channelConfig };
}

async function sendError(
  interaction: ChatInputCommandInteraction,
  err: unknown,
  correlationId: string,
): Promise<void> {
  const content = err instanceof BotError
    ? `**오류:** ${/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(err.message) ? err.message : '요청을 처리하지 못했습니다.'} *(참조: ${correlationId})*`
    : `**예상하지 못한 오류** *(참조: ${correlationId})*`;
  const options = suppressLinkPreviews({ content, flags: MessageFlags.Ephemeral }) as InteractionReplyOptions;

  if (err instanceof BotError) {
    logger.warn(err.message, { code: err.code, correlationId, ...err.context });
  } else {
    logger.error('Unhandled interaction error', { correlationId, err });
  }

  if (interaction.replied) {
    await sendSafely(() => interaction.followUp(options), correlationId);
    return;
  }

  if (interaction.deferred) {
    await sendSafely(() => interaction.followUp(options), correlationId);
    return;
  }

  await sendSafely(() => interaction.reply(options), correlationId);
}

async function respondSafely(
  interaction: AutocompleteInteraction,
  choices: ApplicationCommandOptionChoiceData[],
  correlationId: string,
): Promise<void> {
  await sendSafely(() => interaction.respond(choices), correlationId);
}

async function sendSafely(operation: () => Promise<unknown>, correlationId: string): Promise<void> {
  try {
    await operation();
  } catch (err) {
    logger.warn('Failed to send Discord interaction response', { correlationId, err });
  }
}
