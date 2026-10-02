import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { OpencodeSessionClient, SessionBridge } from '../../opencode/sessionBridge.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { checkAgentAllowed } from '../../utils/permissions.js';
import { suppressLinkPreviews } from '../messageOptions.js';

const logger = createLogger('NewCommand');

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;

interface ThreadLike {
  id: string;
  send(content: unknown): Promise<unknown>;
  members: { add(userId: string): Promise<unknown> };
}

interface ThreadCreatableChannel {
  threads: {
    create(options: { name: string; autoArchiveDuration: number; reason: string }): Promise<ThreadLike>;
  };
}

/** Dependencies for the /new command handler. */
export interface NewCommandDependencies {
  serverManager: { ensureRunning(projectPath: string): Promise<unknown> };
  sessionBridge: Pick<SessionBridge, 'createSession' | 'sendPrompt'>;
  logger?: Pick<Logger, 'info'>;
  rememberThread?: (threadId: string, thread: ThreadLike) => void;
}

/**
 * Create a handler for starting a new OpenCode session thread.
 * @param deps - Server and session bridge dependencies.
 * @returns Discord command handler.
 */
export function createNewCommandHandler(deps: NewCommandDependencies): CommandHandler {
  return async (interaction: ChatInputCommandInteraction, context: InteractionContext): Promise<void> => {
    const log = deps.logger ?? logger;
    log.info('/new started', { correlationId: context.correlationId, channelId: interaction.channelId, guildId: interaction.guildId });
    const channelConfig = requireChannelConfig(context);
    const prompt = interaction.options.getString('prompt');
    const title = normalizeTitle(interaction.options.getString('title'), prompt);
    const agent = interaction.options.getString('agent') ?? channelConfig.defaultAgent ?? 'build';
    log.info('/new options resolved', { correlationId: context.correlationId, projectPath: channelConfig.projectPath, agent, title });
    const agentAllowed = checkAgentAllowed(channelConfig, agent);

    if (agentAllowed !== true) {
      throw new BotError(ErrorCode[agentAllowed.reason], agentAllowed.reason === 'AGENT_SWITCH_DISABLED'
        ? 'Agent switching is disabled for this channel.'
        : `Agent \'${agent}\' is not allowed in this channel.`, { agent });
    }

    log.info('/new deferring reply', { correlationId: context.correlationId });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    log.info('/new reply deferred', { correlationId: context.correlationId });
    const channel = requireThreadCreatableChannel(interaction);
    log.info('/new ensuring OpenCode server', { correlationId: context.correlationId, projectPath: channelConfig.projectPath });
    const client = requireOpencodeClient(await deps.serverManager.ensureRunning(channelConfig.projectPath), channelConfig.projectPath);
    log.info('/new OpenCode server ready', { correlationId: context.correlationId, projectPath: channelConfig.projectPath });
    const thread = await channel.threads.create({ name: title, autoArchiveDuration: 1440, reason: 'OpenCode session' });
    log.info('/new Discord thread created', { correlationId: context.correlationId, threadId: thread.id });
    await thread.members.add(interaction.user.id);
    deps.rememberThread?.(thread.id, thread);
    log.info('/new creating OpenCode session', { correlationId: context.correlationId, threadId: thread.id });
    await deps.sessionBridge.createSession({
      client,
      threadId: thread.id,
      guildId: requireGuildId(interaction),
      channelId: interaction.channelId,
      projectPath: channelConfig.projectPath,
      agent,
      model: channelConfig.model ?? null,
      createdBy: interaction.user.id,
      title,
    });
    if (prompt?.trim()) {
      await thread.send(suppressLinkPreviews(formatInitialPrompt(prompt)));
      log.info('/new sending initial prompt', { correlationId: context.correlationId, threadId: thread.id });
      await deps.sessionBridge.sendPrompt(thread.id, { client, content: prompt, agent, model: channelConfig.model ?? null });
    } else {
      await thread.send(suppressLinkPreviews('OpenCode 세션이 준비되었습니다. 이 스레드에 메시지를 보내 세션을 시작하세요.'));
    }
    log.info('/new editing reply', { correlationId: context.correlationId, threadId: thread.id });
    await interaction.editReply(suppressLinkPreviews({ content: `스레드 ${thread.id}에 OpenCode 세션을 만들었습니다.` }));
    log.info('/new completed', { correlationId: context.correlationId, threadId: thread.id });
  };
}

function requireOpencodeClient(client: unknown, projectPath: string): OpencodeSessionClient {
  if (!client) {
    throw new BotError(ErrorCode.SERVER_START_FAILED, 'OpenCode server is unavailable for this project.', { projectPath });
  }

  return client as OpencodeSessionClient;
}

function requireChannelConfig(context: InteractionContext): ChannelConfig {
  if (!context.channelConfig) {
    throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  }

  return context.channelConfig;
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

function normalizeTitle(title: string | null, prompt: string | null): string {
  const base = title?.trim() || prompt?.trim().slice(0, 50) || 'OpenCode 세션';
  return base.slice(0, 100);
}

function formatInitialPrompt(prompt: string): string {
  return `> **User prompt:**\n${prompt.split('\n').map((line) => `> ${line}`).join('\n')}`;
}
