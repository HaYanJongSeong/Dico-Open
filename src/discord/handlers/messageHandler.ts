import type { Message } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { downloadAndSave, type DiscordAttachmentLike } from '../../opencode/attachments.js';
import type { StateManager } from '../../state/manager.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { generateCorrelationId } from '../../utils/logger.js';
import { checkUserAllowed } from '../../utils/permissions.js';
import type { ChannelConfig } from '../../config/types.js';
import { suppressLinkPreviews } from '../messageOptions.js';

/** File metadata consumed from the per-thread context buffer. */
export interface ContextFile {
  path: string;
  url: string;
  mime?: string;
  filename?: string;
}

/** Options passed when sending a Discord message to an OpenCode session. */
export interface SendPromptOptions {
  session: SessionState;
  correlationId: string;
  contextFiles: ContextFile[];
}

/** Handles answers for pending OpenCode questions. */
export interface QuestionAnswerHandler {
  /**
   * Check whether the thread is awaiting a user answer.
   * @param threadId - Discord thread ID
   * @returns True when an OpenCode question is pending
   */
  hasPendingQuestion(threadId: string): boolean;

  /**
   * Handle the next user message as an answer to a pending question.
   * @param threadId - Discord thread ID
   * @param content - User message content
   * @param correlationId - Correlation ID for tracing
   * @returns Nothing
   */
  handleQuestionAnswer(threadId: string, content: string, correlationId: string): Promise<void>;
}

/** Bridges Discord thread messages to OpenCode session prompts. */
export interface SessionPromptBridge {
  /**
   * Check whether the session is currently processing a prompt.
   * @param threadId - Discord thread ID
   * @returns True when a prompt is already in flight
   */
  isBusy(threadId: string): boolean;

  /**
   * Send a user prompt to the active OpenCode session.
   * @param threadId - Discord thread ID
   * @param content - User message content
   * @param options - Session, correlation, and context metadata
   * @returns Nothing
   */
  sendPrompt(threadId: string, content: string, options: SendPromptOptions): Promise<void>;
}

/** Downloads Discord message attachments into files OpenCode can consume. */
export interface AttachmentProvider {
  /**
   * Download attachments for a message and session.
   * @param message - Discord message containing attachments.
   * @param session - Active session that owns attachment storage.
   * @returns Saved files to include with a prompt.
   */
  download(message: Message, session: SessionState): Promise<ContextFile[]>;
}

/** Dependencies for handling Discord messageCreate events. */
export interface MessageHandlerOptions {
  stateManager: StateManager;
  getChannelConfig?: (session: SessionState) => Pick<ChannelConfig, 'allowedUsers'> | undefined;
  questionHandler: QuestionAnswerHandler;
  sessionBridge: SessionPromptBridge;
  attachmentProvider?: AttachmentProvider;
  now?: () => number;
}

const SESSION_RECOVERY_NOTICE = '재시작 후 이전 OpenCode 세션을 복구하지 못했습니다. `/new`로 새 세션을 만들거나 `/connect`로 기존 세션에 연결하세요.';

/**
 * Handle Discord messageCreate events for thread passthrough sessions.
 * @param message - Incoming Discord message
 * @param options - Handler dependencies
 * @returns Nothing
 */
export async function handleMessageCreate(
  message: Message,
  options: MessageHandlerOptions,
): Promise<void> {
  if (message.author.bot) {
    return;
  }

  if (!message.channel.isThread()) {
    return;
  }

  const threadId = message.channel.id ?? message.channelId;
  const correlationId = generateCorrelationId(threadId);

  const storedSession = options.stateManager.getSession(threadId);
  if (!storedSession || storedSession.status === 'ended') {
    return;
  }
  const config = options.getChannelConfig?.(storedSession);
  if (options.getChannelConfig && (!config || !checkUserAllowed(config, message.author.id))) return;

  if (options.questionHandler.hasPendingQuestion(threadId)) {
    await options.questionHandler.handleQuestionAnswer(threadId, message.content, correlationId);
    return;
  }

  const now = options.now?.() ?? Date.now();
  const session = storedSession.status === 'inactive'
    ? { ...storedSession, status: 'active' as const, lastActivityAt: now }
    : storedSession;

  if (session !== storedSession) {
    options.stateManager.setSession(threadId, session);
  }

  const attachmentFiles = await downloadAttachments(options.attachmentProvider, message, session);

  if (options.sessionBridge.isBusy(threadId)) {
    options.stateManager.enqueue(threadId, {
      userId: message.author.id,
      content: message.content,
      attachments: attachmentFiles.map((file) => file.path),
      queuedAt: now,
    });
    return;
  }

  try {
    await options.sessionBridge.sendPrompt(threadId, message.content, {
      session,
      correlationId,
      contextFiles: attachmentFiles,
    });
  } catch (error) {
    if (error instanceof BotError && error.code === ErrorCode.SESSION_NOT_FOUND) {
      options.stateManager.setSession(threadId, { ...session, status: 'ended' });
      options.stateManager.clearQueue(threadId);
      await message.channel.send(suppressLinkPreviews(SESSION_RECOVERY_NOTICE));
      return;
    }

    throw error;
  }
}

async function downloadAttachments(
  attachmentProvider: AttachmentProvider | undefined,
  message: Message,
  session: SessionState,
): Promise<ContextFile[]> {
  if (attachmentProvider) {
    return attachmentProvider.download(message, session);
  }

  return Promise.all(getDiscordAttachments(message).map(async (attachment) => {
    const saved = await downloadAndSave(attachment, session.projectPath, { messageId: message.id });
    return {
      path: saved.path,
      url: pathToFileURL(saved.path).href,
      mime: saved.mime,
      filename: saved.filename,
    };
  }));
}

function getDiscordAttachments(message: Message): DiscordAttachmentLike[] {
  return Array.from(message.attachments.values()).map((attachment) => ({
    id: attachment.id,
    url: attachment.url,
    name: attachment.name,
    contentType: attachment.contentType,
  }));
}
