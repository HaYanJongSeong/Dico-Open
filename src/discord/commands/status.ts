import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { BotState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { suppressLinkPreviews } from '../messageOptions.js';

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;

const EMBED_FIELD_LIMIT = 1024;

interface StatusStateManager {
  getState(): BotState;
}

interface StreamStatusProvider {
  getStatus(threadId: string): { state: string; failures: number } | undefined;
}

/** Dependencies for the /status command handler. */
export interface StatusCommandDependencies {
  stateManager: StatusStateManager;
  streamStatusProvider?: StreamStatusProvider;
}

/**
 * Create a handler for showing channel-level server and session status.
 * @param deps - State dependency.
 * @returns Discord command handler.
 */
export function createStatusCommandHandler(deps: StatusCommandDependencies): CommandHandler {
  return async (interaction: ChatInputCommandInteraction, context: InteractionContext): Promise<void> => {
    if ((interaction.channel as { parentId?: string | null } | null)?.parentId) {
      throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Status can only be used in a configured project channel.');
    }

    if (!context.channelConfig) {
      throw new BotError(ErrorCode.CONFIG_CHANNEL_NOT_FOUND, 'This channel is not configured for OpenCode.');
    }

    const state = deps.stateManager.getState();
    const server = state.servers[context.channelConfig.projectPath];
    const sessions = Object.entries(state.sessions).filter(([, session]) =>
      session.channelId === context.channelConfig?.channelId && session.projectPath === context.channelConfig.projectPath && session.status === 'active');
    const embed = new EmbedBuilder()
      .setTitle('OpenCode 상태')
      .setColor(0x5865f2)
      .addFields(
        { name: '서버', value: server ? `${server.status} (${server.url})` : '실행 안 됨', inline: false },
        { name: '활성 세션', value: String(sessions.length), inline: true },
        { name: '스레드', value: formatSessions(sessions, state, deps.streamStatusProvider), inline: false },
      );

    await interaction.reply(suppressLinkPreviews({ embeds: [embed] }));
  };
}

function formatSessions(sessions: Array<[string, BotState['sessions'][string]]>, state: BotState, streamStatusProvider?: StreamStatusProvider): string {
  if (sessions.length === 0) {
    return '활성 세션이 없습니다.';
  }

  const lines: string[] = [];
  for (const [threadId, session] of sessions) {
    const stream = streamStatusProvider?.getStatus(threadId);
    const streamText = stream ? `, 스트림 ${stream.state}, 실패 ${stream.failures}` : ', 스트림 구독 안 됨';
    const next = `${threadId}: ${session.agent}, <@${session.createdBy}> 생성 (대기열 ${state.queues[threadId]?.length ?? 0}${streamText})`;
    const suffix = `\n... 세션 ${sessions.length - lines.length}개 생략됨`;
    const candidate = [...lines, next].join('\n');
    if (candidate.length + suffix.length > EMBED_FIELD_LIMIT) {
      lines.push(`... 세션 ${sessions.length - lines.length}개 생략됨`);
      break;
    }
    lines.push(next);
  }

  return lines.join('\n').slice(0, EMBED_FIELD_LIMIT);
}
