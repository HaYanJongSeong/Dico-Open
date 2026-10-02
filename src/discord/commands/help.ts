import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import { suppressLinkPreviews } from '../messageOptions.js';

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;

/**
 * Create a context-aware help command handler.
 * @returns Discord command handler.
 */
export function createHelpCommandHandler(): CommandHandler {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const inThread = Boolean((interaction.channel as { parentId?: string | null } | null)?.parentId);
    const commands = inThread
      ? ['`/agent set` 이 스레드의 에이전트 변경', '`/agent list` 에이전트 목록', '`/model set` 이 스레드의 모델 변경', '`/model list` 모델 목록', '`/interrupt` 작업 중단', '`/info` 세션 정보', '`/inspect` 유형별 메시지 비공개 조회', '`/diff` 세션 변경 사항', '`/sync status` 동기화 상태', '`/sync now` 즉시 동기화']
      : ['`/new` 세션 시작', '`/connect` 기존 세션 연결', '`/agent list` 에이전트 목록', '`/model list` 모델 목록', '`/status` 채널 상태', '`/sync status` 동기화 상태', '`/sync now` 즉시 동기화'];

    await interaction.reply(suppressLinkPreviews({ content: commands.join('\n'), flags: MessageFlags.Ephemeral }));
  };
}
