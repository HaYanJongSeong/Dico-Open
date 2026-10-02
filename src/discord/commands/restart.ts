import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { BotState, SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { suppressLinkPreviews } from '../messageOptions.js';

interface CommandContext { correlationId: string; channelConfig?: ChannelConfig }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
interface ComponentInteractionLike { customId: string; user?: { id: string }; deferUpdate?(): Promise<unknown>; editReply?(options: unknown): Promise<unknown>; reply(options: unknown): Promise<unknown>; update(options: unknown): Promise<unknown> }
interface ComponentCollectorLike { on(event: 'collect', listener: (interaction: ComponentInteractionLike) => Promise<void>): void; on(event: 'end', listener: (collected: unknown, reason: string) => Promise<void>): void }
interface MessageWithCollector { createMessageComponentCollector(options: { time: number }): ComponentCollectorLike; edit(options: unknown): Promise<unknown> }
interface ThreadLike { send(content: unknown): Promise<unknown> }
const logger = createLogger('RestartCommand');

/** Dependencies for the /restart command handler. */
export interface RestartCommandDependencies {
  stateManager: { getState(): Pick<BotState, 'sessions'> };
  serverManager: { getClient(projectPath: string): unknown | undefined; canRestart(projectPath: string): boolean; shutdown(projectPath: string): Promise<void>; ensureRunning(projectPath: string): Promise<unknown> };
  streamHandler: { unsubscribe(threadId: string): void; subscribe(threadId: string, sessionId: string, client: unknown, dedupeSet?: Set<string>, projectPath?: string): Promise<void> | void };
  getDedupeSet(threadId: string): Set<string>;
  cacheManager: { refresh(projectPath: string, client: unknown): Promise<void> };
  getThread(threadId: string): ThreadLike | undefined;
  logger?: Pick<Logger, 'error'>;
}

/**
 * Create a handler for restarting an OpenCode server after button confirmation.
 * @param deps - State, server, stream, cache, and Discord thread dependencies.
 * @returns Discord command handler.
 */
export function createRestartCommandHandler(deps: RestartCommandDependencies): CommandHandler {
  return async (interaction, context): Promise<void> => {
    const channelConfig = requireChannelConfig(context);
    requireRestartable(deps, channelConfig.projectPath);
    const sessions = getActiveProjectSessions(deps.stateManager.getState().sessions, channelConfig.projectPath);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('restart-confirm').setLabel('재시작').setStyle(ButtonStyle.Danger),
    );
    const message = await interaction.reply(suppressLinkPreviews({
      content: `${channelConfig.projectPath}의 OpenCode 서버를 재시작합니다. 활성 세션 ${sessions.length}개가 모두 중단됩니다.`,
      components: [row],
      fetchReply: true,
    }));
    const collectorMessage = message as unknown as Partial<MessageWithCollector>;
    const collector = collectorMessage.createMessageComponentCollector?.({ time: 30_000 });
    let completed = false;

    collector?.on('collect', async (componentInteraction) => {
      if (componentInteraction.user?.id !== interaction.user.id) {
        await componentInteraction.reply(suppressLinkPreviews({ content: '재시작을 요청한 사용자만 확인할 수 있습니다.', flags: MessageFlags.Ephemeral }));
        return;
      }
      if (componentInteraction.customId !== 'restart-confirm') return;
      try {
        await componentInteraction.deferUpdate?.();
        await restartProject(deps, channelConfig.projectPath, sessions);
        completed = true;
        await updateConfirmation(componentInteraction, { content: `\`${channelConfig.projectPath}\`의 OpenCode 서버를 재시작했습니다.`, components: [] });
      } catch (err) {
        completed = true;
        const activeLogger = deps.logger ?? logger;
        activeLogger.error('Restart confirmation failed', { correlationId: context.correlationId, projectPath: channelConfig.projectPath, err });
        await updateConfirmation(componentInteraction, { content: `재시작에 실패했습니다. *(참조: ${context.correlationId})*`, components: [] });
      }
    });

    collector?.on('end', async (_collected, reason) => {
      if (!completed && reason === 'time' && collectorMessage.edit) await collectorMessage.edit(suppressLinkPreviews({ content: '재시작 확인 시간이 만료되었습니다.', components: [] }));
    });
  };
}

async function restartProject(deps: RestartCommandDependencies, projectPath: string, sessions: Array<{ threadId: string; session: SessionState }>): Promise<void> {
  requireRestartable(deps, projectPath);
  for (const { threadId } of sessions) {
    deps.streamHandler.unsubscribe(threadId);
  }

  await deps.serverManager.shutdown(projectPath);
  const client = await deps.serverManager.ensureRunning(projectPath);
  try { await deps.cacheManager.refresh(projectPath, client); } catch { /* cache refresh is best-effort after restart */ }

  for (const { threadId, session } of sessions) {
    await deps.streamHandler.subscribe(threadId, session.sessionId, client, deps.getDedupeSet(threadId), projectPath);
    await deps.getThread(threadId)?.send(suppressLinkPreviews('서버를 재시작했습니다. 세션을 다시 연결했습니다.'));
  }
}

function requireRestartable(deps: RestartCommandDependencies, projectPath: string): void {
  if (!deps.serverManager.canRestart(projectPath)) {
    throw new BotError(ErrorCode.SERVER_START_FAILED, '봇이 직접 실행한 서버만 재시작할 수 있습니다. 공유 또는 복구된 서버는 재시작할 수 없습니다.');
  }
}

async function updateConfirmation(componentInteraction: ComponentInteractionLike, options: { content: string; components: [] }): Promise<void> {
  if (componentInteraction.editReply) {
    await componentInteraction.editReply(suppressLinkPreviews(options));
    return;
  }

  await componentInteraction.update(suppressLinkPreviews(options));
}

function getActiveProjectSessions(sessions: Record<string, SessionState>, projectPath: string): Array<{ threadId: string; session: SessionState }> {
  return Object.entries(sessions).filter(([, session]) => session.projectPath === projectPath && session.status === 'active').map(([threadId, session]) => ({ threadId, session }));
}

function requireChannelConfig(context: CommandContext): ChannelConfig {
  if (!context.channelConfig) throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
  return context.channelConfig;
}
