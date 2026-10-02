import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { OpencodeSessionClient, SessionBridge } from '../../opencode/sessionBridge.js';
import type { BotState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { suppressLinkPreviews } from '../messageOptions.js';

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;

interface StateReader {
  getState(): BotState;
}

interface ThreadLike {
  id: string;
  send(content: unknown): Promise<unknown>;
}

interface ThreadCreatableChannel {
  threads: {
    create(options: { name: string; autoArchiveDuration: number; reason: string }): Promise<ThreadLike>;
  };
}

/** Dependencies for the /connect command handler. */
export interface ConnectCommandDependencies {
  stateManager: StateReader;
  serverManager: { ensureRunning(projectPath: string): Promise<unknown> };
  sessionBridge: Pick<SessionBridge, 'connectToSession'>;
}

/**
 * Create a handler for attaching Discord threads to existing OpenCode sessions.
 * @param deps - State, server, and session bridge dependencies.
 * @returns Discord command handler.
 */
export function createConnectCommandHandler(deps: ConnectCommandDependencies): CommandHandler {
  return async (interaction: ChatInputCommandInteraction, context: InteractionContext): Promise<void> => {
    const channelConfig = requireChannelConfig(context);
    const sessionId = interaction.options.getString('session', true);
    assertUnattached(deps.stateManager.getState(), sessionId);

    const channel = requireThreadCreatableChannel(interaction);
    const title = normalizeTitle(interaction.options.getString('title'), sessionId);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const client = await deps.serverManager.ensureRunning(channelConfig.projectPath) as OpencodeSessionClient;
    const thread = await channel.threads.create({ name: title, autoArchiveDuration: 1440, reason: 'OpenCode session attach' });

    await deps.sessionBridge.connectToSession({
      client,
      threadId: thread.id,
      guildId: requireGuildId(interaction),
      channelId: interaction.channelId,
      projectPath: channelConfig.projectPath,
      sessionId,
      agent: channelConfig.defaultAgent ?? 'build',
      model: channelConfig.model ?? null,
      createdBy: interaction.user.id,
      historyLimit: channelConfig.connectHistoryLimit,
      thread,
    });
    await interaction.editReply(suppressLinkPreviews({ content: `스레드 ${thread.id}을 세션 ${sessionId}에 연결했습니다.` }));
  };
}

function requireChannelConfig(context: InteractionContext): ChannelConfig {
  if (!context.channelConfig) {
    throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  }

  return context.channelConfig;
}

function assertUnattached(state: BotState, sessionId: string): void {
  const attached = Object.values(state.sessions).some((session) => session.sessionId === sessionId && session.status !== 'ended');
  if (attached) {
    throw new BotError(ErrorCode.SESSION_ALREADY_ATTACHED, `Session ${sessionId} is already attached to a Discord thread.`, { sessionId });
  }
}

function requireGuildId(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'This command can only be used in a server.');
  }

  return interaction.guildId;
}

function requireThreadCreatableChannel(interaction: ChatInputCommandInteraction): ThreadCreatableChannel {
  const channel = interaction.channel as Partial<ThreadCreatableChannel> | null;
  if (!channel?.threads?.create) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'This command can only be used in a channel that supports threads.');
  }

  return channel as ThreadCreatableChannel;
}

function normalizeTitle(title: string | null, sessionId: string): string {
  return (title?.trim() || `OpenCode ${sessionId}`).slice(0, 100);
}
