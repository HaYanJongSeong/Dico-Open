import { AttachmentBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { suppressLinkPreviews } from '../messageOptions.js';

interface CommandContext { correlationId: string }
type CommandHandler = (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;

interface DiffStateManager { getSession(threadId: string): SessionState | undefined }
interface DiffClient { session: { diff(options: { sessionID: string }): Promise<unknown> } }

/** Dependencies for the /diff command handler. */
export interface DiffCommandDependencies {
  stateManager: DiffStateManager;
  serverManager: { getClient(projectPath: string): unknown | undefined };
  splitMessage?: (text: string) => string[];
  createAttachment?: (content: string, name: string) => unknown;
}

/**
 * Create a handler for showing the active session diff.
 * @param deps - State, server, and formatting dependencies.
 * @returns Discord command handler.
 */
export function createDiffCommandHandler(deps: DiffCommandDependencies): CommandHandler {
  return async (interaction): Promise<void> => {
    const { session } = requireThreadSession(interaction, deps.stateManager, 'Diff can only be used in a session thread.');
    const client = requireClient(deps.serverManager, session.projectPath);
    await interaction.deferReply();
    const diff = extractText(await client.session.diff({ sessionID: session.sessionId })).trim();

    if (!diff) {
      await interaction.editReply(suppressLinkPreviews({ content: '이 세션에 파일 변경 사항이 없습니다.' }));
      return;
    }

    const createAttachment = deps.createAttachment ?? defaultCreateAttachment;
    const attachment = createAttachment(diff, 'session.diff');
    await interaction.editReply(suppressLinkPreviews({ content: `프로젝트:\n\`\`\`\n${session.projectPath}\n\`\`\``, files: [attachment as AttachmentBuilder] }));
  };
}

function defaultCreateAttachment(content: string, name: string): AttachmentBuilder {
  return new AttachmentBuilder(Buffer.from(content), { name });
}

function requireThreadSession(interaction: ChatInputCommandInteraction, stateManager: DiffStateManager, message: string): { threadId: string; session: SessionState } {
  if (!((interaction.channel as { parentId?: string | null } | null)?.parentId)) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, message);
  }

  const session = stateManager.getSession(interaction.channelId);
  if (!session || session.status !== 'active') {
    throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active session is attached to this thread.', { threadId: interaction.channelId });
  }

  return { threadId: interaction.channelId, session };
}

function requireClient(serverManager: DiffCommandDependencies['serverManager'], projectPath: string): DiffClient {
  const client = serverManager.getClient(projectPath) as DiffClient | undefined;
  if (!client) {
    throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode server is not running for this project.', { projectPath });
  }
  return client;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractPatch).filter(Boolean).join('\n');
  if (isRecord(value) && value.error != null) throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode 변경 사항을 가져오지 못했습니다.');
  if (isRecord(value) && 'data' in value) return extractText(value.data);
  if (isRecord(value) && typeof value.diff === 'string') return value.diff;
  return '';
}

function extractPatch(value: unknown): string {
  return isRecord(value) && typeof value.patch === 'string' ? value.patch : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
