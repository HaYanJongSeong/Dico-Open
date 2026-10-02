import type { ChatInputCommandInteraction } from 'discord.js';
import type { OpencodeSessionClient, SessionBridge } from '../../opencode/sessionBridge.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { suppressLinkPreviews } from '../messageOptions.js';

interface CommandContext {
  correlationId: string;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;

interface InterruptStateManager {
  getSession(threadId: string): SessionState | undefined;
  clearQueue(threadId: string): void;
}

/** Dependencies for the /interrupt command handler. */
export interface InterruptCommandDependencies {
  stateManager: InterruptStateManager;
  serverManager: { getClient(projectPath: string): unknown | undefined };
  sessionBridge: Pick<SessionBridge, 'abortSession'>;
}

/**
 * Create a handler for aborting the active OpenCode session.
 * @param deps - State, server, and session bridge dependencies.
 * @returns Discord command handler.
 */
export function createInterruptCommandHandler(deps: InterruptCommandDependencies): CommandHandler {
  return async (interaction): Promise<void> => {
    const threadId = requireThreadId(interaction);
    const session = deps.stateManager.getSession(threadId);
    if (!session || session.status !== 'active') {
      throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active session is attached to this thread.', { threadId });
    }

    const client = deps.serverManager.getClient(session.projectPath) as OpencodeSessionClient | undefined;
    if (!client) {
      throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode server is not running for this project.', { projectPath: session.projectPath });
    }

    await interaction.deferReply();
    await deps.sessionBridge.abortSession(threadId, client);
    deps.stateManager.clearQueue(threadId);
    await interaction.editReply(suppressLinkPreviews({ content: '세션을 중단하고 대기열을 비웠습니다.' }));
  };
}

function requireThreadId(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel as { parentId?: string | null } | null;
  if (!channel?.parentId) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Interrupt can only be used in a session thread.');
  }

  return interaction.channelId;
}
