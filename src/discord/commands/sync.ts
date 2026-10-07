import type { ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

type CommandHandler = (interaction: ChatInputCommandInteraction, context: { channelConfig?: ChannelConfig }) => Promise<void>;

export interface SyncController {
  getStatus(): { intervalMinutes: number; paused: boolean };
  runNow(): Promise<void>;
  wake(): void;
}

export function createSyncCommandHandler(controller: SyncController): CommandHandler {
  return async (interaction) => {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'status') {
      const status = controller.getStatus();
      const interval = status.intervalMinutes < 1 ? `${Math.round(status.intervalMinutes * 60)}초` : `${status.intervalMinutes}분`;
      await interaction.reply(`동기화: ${status.paused ? '일시정지' : '실행 중'}\n주기: ${interval}`);
      return;
    }
    if (subcommand === 'now') {
      await interaction.deferReply({ ephemeral: true });
      await controller.runNow();
      await interaction.editReply('동기화 완료');
      return;
    }
    throw new BotError(ErrorCode.DISCORD_API_ERROR, `지원하지 않는 동기화 명령: ${subcommand}`);
  };
}
