import { suppressLinkPreviews } from '../discord/messageOptions.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { MessageFlags } from 'discord.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const logger = createLogger('PermissionHandler');

type PermissionReply = 'once' | 'always' | 'reject';

/** OpenCode permission request payload. */
export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: unknown;
  always?: string[];
}

/** OpenCode client subset required to answer permission requests. */
export interface PermissionClient {
  permission: {
    /**
     * Reply to an OpenCode permission request.
     * @param input - Request ID and permission decision.
     * @returns OpenCode reply result.
     */
    reply(input: { requestID: string; reply: PermissionReply }): Promise<unknown>;
  };
  v2Root?: {
    session: {
      permission?: {
        reply(input: { sessionID: string; requestID: string; reply: PermissionReply }): Promise<unknown>;
      };
    };
  };
}

/** Discord thread subset required by permission handling. */
export interface PermissionThread {
  /**
   * Send a message or embed payload to the thread.
   * @param payload - Message content or embed payload.
   * @returns Sent Discord message.
   */
  send(payload: string | { embeds?: unknown[]; components?: unknown[]; content?: string; flags?: number }): Promise<PermissionMessage>;
}

/** Discord message subset required by permission handling. */
export interface PermissionMessage {
  /**
   * Create a component collector for permission button clicks.
   * @param options - Collector timeout options.
   * @returns Component collector.
   */
  createMessageComponentCollector(options: { time: number }): PermissionCollector;

  /**
   * Edit the permission message after an answer or timeout.
   * @param payload - Replacement message payload.
   * @returns Discord API edit result.
   */
  edit?(payload: { embeds?: unknown[]; components?: unknown[]; content?: string; flags?: number }): Promise<unknown>;
}

/** Discord component collector subset required by permission handling. */
export interface PermissionCollector {
  /**
   * Register a collect handler for button interactions.
   * @param event - Collector event name.
   * @param callback - Handler invoked with the collected interaction.
   * @returns This collector.
   */
  on(event: 'collect', callback: (interaction: PermissionInteraction) => void | Promise<void>): PermissionCollector;

  /**
   * Register an end handler for timeout handling.
   * @param event - Collector event name.
   * @param callback - Handler invoked when collection ends.
   * @returns This collector.
   */
  on(event: 'end', callback: (collected: unknown, reason: string) => void | Promise<void>): PermissionCollector;

  /**
   * Stop the collector after a permission decision.
   * @param reason - Optional stop reason.
   * @returns Nothing.
   */
  stop?(reason?: string): void;
}

/** Discord button interaction subset required by permission handling. */
export interface PermissionInteraction {
  customId: string;
  user?: { id: string };
  reply?(payload: { content: string; flags: number }): Promise<unknown>;

  /**
   * Acknowledge and update the button message.
   * @param payload - Interaction update payload.
   * @returns Discord API update result.
   */
  update?(payload: { embeds?: unknown[]; components?: unknown[]; content?: string }): Promise<unknown>;
}

/** Channel permission handling configuration. */
export interface PermissionChannelConfig {
  permissions?: 'auto' | 'interactive';
  allowedUsers?: string[];
}

/** Options for constructing a permission handler. */
export interface PermissionHandlerOptions {
  /**
   * Resolve a Discord thread by ID.
   * @param threadId - Discord thread ID.
   * @returns Thread when available, otherwise undefined.
   */
  getThread(threadId: string): PermissionThread | undefined;

  /**
   * Resolve channel configuration by Discord thread ID.
   * @param threadId - Discord thread ID.
   * @returns Channel config when available, otherwise undefined.
   */
  getChannelConfig(threadId: string): PermissionChannelConfig | undefined;

  timeoutMs?: number;
}

interface PermissionEventLike {
  request?: unknown;
}

interface PermissionEmbed {
  title: string;
  description: string;
}

interface PermissionButton {
  type: 2;
  custom_id: string;
  label: string;
  style: 1 | 3 | 4;
}

interface PermissionActionRow {
  type: 1;
  components: PermissionButton[];
}

interface SdkErrorEnvelope {
  error: {
    message?: string;
  };
}

/** Handles OpenCode permission requests with auto or interactive Discord replies. */
export class PermissionHandler {
  private readonly timeoutMs: number;

  /**
   * Create a permission handler.
   * @param options - Permission handler dependencies and timing configuration.
   * @returns PermissionHandler instance.
   */
  public constructor(private readonly options: PermissionHandlerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Handle a permission request from OpenCode.
   * @param threadId - Discord thread ID receiving the permission request.
   * @param event - OpenCode permission event or direct request payload.
   * @param client - OpenCode client for replies.
   * @returns Completion once the request is auto-answered or posted for interaction.
   */
  public async handlePermissionEvent(threadId: string, event: unknown, client: PermissionClient): Promise<void> {
    const request = this.extractRequest(event);
    const config = this.options.getChannelConfig(threadId);
    if (!config) {
      this.assertNoSdkError(await this.reply(client, request, 'reject'), ErrorCode.PERMISSION_DENIED);
      return;
    }
    const mode = config?.permissions ?? 'auto';

    if (mode === 'auto') {
      this.assertNoSdkError(await this.reply(client, request, 'always'), ErrorCode.PERMISSION_DENIED);
      return;
    }

    const thread = this.options.getThread(threadId);
    if (!thread) {
      this.assertNoSdkError(await this.reply(client, request, 'reject'), ErrorCode.PERMISSION_DENIED);
      return;
    }

    const message = await this.postInteractiveRequest(thread, request, client);
    if (message === undefined) {
      return;
    }

    let answered = false;
    let submitting = false;
    let timeoutPending = false;
    const collector = message.createMessageComponentCollector({ time: this.timeoutMs });

    collector.on('collect', (interaction) => {
      void this.handleCollect(threadId, interaction, request, client, collector, () => answered || submitting, () => {
        submitting = true;
      }, () => {
        submitting = false;
      }, () => {
        answered = true;
      }).catch((error: unknown) => {
        submitting = false;
        logger.warn('Permission interaction handling failed', { code: ErrorCode.PERMISSION_DENIED, requestID: request.id, error });
        if (timeoutPending) {
          void this.handleEnd('time', request, client, message, () => answered, () => {
            answered = true;
          }).catch((timeoutError: unknown) => {
            logger.warn('Permission timeout handling failed', { code: ErrorCode.PERMISSION_TIMEOUT, requestID: request.id, error: timeoutError });
            void message.edit?.({ content: '권한 요청 시간 만료 처리에 실패했습니다. 다시 시도하세요.', components: [] }).catch((editError: unknown) => {
              logger.warn('Permission timeout failure notice failed', { code: ErrorCode.DISCORD_API_ERROR, requestID: request.id, error: editError });
            });
          });
          return;
        }
        void interaction.update?.({ content: '권한 응답에 실패했습니다. 다시 시도하세요.', components: [this.createActionRow()] }).catch((updateError: unknown) => {
          logger.warn('Permission interaction failure notice failed', { code: ErrorCode.DISCORD_API_ERROR, requestID: request.id, error: updateError });
        });
      });
    });

    collector.on('end', (_collected, reason) => {
      if (reason === 'time' && submitting) {
        timeoutPending = true;
        return;
      }
      void this.handleEnd(reason, request, client, message, () => answered, () => {
        answered = true;
      }).catch((error: unknown) => {
        logger.warn('Permission timeout handling failed', { code: ErrorCode.PERMISSION_TIMEOUT, requestID: request.id, error });
        void message.edit?.({ content: '권한 요청 시간 만료 처리에 실패했습니다. 다시 시도하세요.', components: [] }).catch((editError: unknown) => {
          logger.warn('Permission timeout failure notice failed', { code: ErrorCode.DISCORD_API_ERROR, requestID: request.id, error: editError });
        });
      });
    });
  }

  private async postInteractiveRequest(thread: PermissionThread, request: PermissionRequest, client: PermissionClient): Promise<PermissionMessage | undefined> {
    try {
      return await thread.send(suppressLinkPreviews({ embeds: [this.createEmbed(request)], components: [this.createActionRow()] }));
    } catch (error) {
      logger.warn('Permission prompt posting failed', { code: ErrorCode.DISCORD_API_ERROR, requestID: request.id, error });
      try {
         this.assertNoSdkError(await this.reply(client, request, 'reject'), ErrorCode.PERMISSION_DENIED);
      } catch (rejectError) {
        logger.warn('Permission prompt fallback reject failed', { code: ErrorCode.PERMISSION_DENIED, requestID: request.id, error: rejectError });
      }
      return undefined;
    }
  }

  private async handleCollect(
    threadId: string,
    interaction: PermissionInteraction,
    request: PermissionRequest,
    client: PermissionClient,
    collector: PermissionCollector,
    isAnswered: () => boolean,
    markSubmitting: () => void,
    clearSubmitting: () => void,
    markAnswered: () => void,
  ): Promise<void> {
    const config = this.options.getChannelConfig(threadId);
    if (!config || !interaction.user || (config.allowedUsers?.length && !config.allowedUsers.includes(interaction.user.id))) {
      await interaction.reply?.({ content: '이 권한 요청에 응답할 수 없습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    const reply = this.getReplyForCustomId(interaction.customId);
    if (!reply || isAnswered()) {
      return;
    }

    markSubmitting();
    const result = client.v2Root?.session.permission?.reply !== undefined
      ? await this.reply(client, request, reply)
      : await client.permission.reply({ requestID: request.id, reply });
    this.assertNoSdkError(result, ErrorCode.PERMISSION_DENIED);
    clearSubmitting();
    markAnswered();
    await interaction.update?.({ content: this.createAnsweredNotice(reply), components: [] });
    collector.stop?.('answered');
  }

  private async handleEnd(
    reason: string,
    request: PermissionRequest,
    client: PermissionClient,
    message: PermissionMessage,
    isAnswered: () => boolean,
    markAnswered: () => void,
  ): Promise<void> {
    if (isAnswered() || reason !== 'time') {
      return;
    }

    markAnswered();
    const result = client.v2Root?.session.permission?.reply !== undefined
      ? await this.reply(client, request, 'reject')
      : await client.permission.reply({ requestID: request.id, reply: 'reject' });
    this.assertNoSdkError(result, ErrorCode.PERMISSION_TIMEOUT);
    await message.edit?.({ content: '권한 요청 시간이 만료되어 거부했습니다.', components: [] });
  }

  private extractRequest(event: unknown): PermissionRequest {
    const candidate = this.isPermissionEventLike(event) && event.request ? event.request : event;
    if (this.isCurrentPermissionRequest(candidate)) {
      return {
        id: candidate.id,
        sessionID: candidate.sessionID,
        permission: candidate.action,
        patterns: candidate.resources,
        always: Array.isArray(candidate.save) ? candidate.save.filter((value): value is string => typeof value === 'string') : undefined,
        metadata: candidate.metadata ?? candidate.source,
      };
    }
    if (!this.isPermissionRequest(candidate)) {
      throw new BotError(ErrorCode.PERMISSION_DENIED, 'Invalid permission request payload');
    }
    return candidate;
  }

  private isPermissionEventLike(value: unknown): value is PermissionEventLike {
    return typeof value === 'object' && value !== null && 'request' in value;
  }

  private isPermissionRequest(value: unknown): value is PermissionRequest {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const request = value as Partial<PermissionRequest>;
    return typeof request.id === 'string' && typeof request.sessionID === 'string' && typeof request.permission === 'string' && Array.isArray(request.patterns);
  }

  private createEmbed(request: PermissionRequest): PermissionEmbed {
    return {
      title: '권한 요청',
      description: [`권한: ${request.permission}`, `대상: ${request.patterns.join(', ')}`].join('\n'),
    };
  }

  private createActionRow(): PermissionActionRow {
    return {
      type: 1,
      components: [
        { type: 2, custom_id: 'allow_once', label: '한 번 허용', style: 1 },
        { type: 2, custom_id: 'allow_always', label: '항상 허용', style: 3 },
        { type: 2, custom_id: 'reject', label: '거부', style: 4 },
      ],
    };
  }

  private getReplyForCustomId(customId: string): PermissionReply | undefined {
    if (customId === 'allow_once') {
      return 'once';
    }
    if (customId === 'allow_always') {
      return 'always';
    }
    if (customId === 'reject') {
      return 'reject';
    }
    return undefined;
  }

  private createAnsweredNotice(reply: PermissionReply): string {
    if (reply === 'reject') {
      return '권한을 거부했습니다.';
    }
    return reply === 'always' ? '권한을 항상 허용했습니다.' : '권한을 한 번 허용했습니다.';
  }

  private assertNoSdkError(result: unknown, code: ErrorCode): void {
    if (this.isSdkErrorEnvelope(result)) {
      throw new BotError(code, result.error.message ?? 'OpenCode permission request failed');
    }
  }

  private isCurrentPermissionRequest(value: unknown): value is {
    id: string; sessionID: string; action: string; resources: string[]; save?: unknown; metadata?: unknown; source?: unknown;
  } {
    if (typeof value !== 'object' || value === null) return false;
    const request = value as Record<string, unknown>;
    return typeof request.id === 'string' && typeof request.sessionID === 'string'
      && typeof request.action === 'string' && Array.isArray(request.resources)
      && request.resources.every((resource) => typeof resource === 'string');
  }

  private async reply(client: PermissionClient, request: PermissionRequest, reply: PermissionReply): Promise<unknown> {
    if (client.v2Root?.session.permission?.reply !== undefined) {
      return await client.v2Root.session.permission.reply({ sessionID: request.sessionID, requestID: request.id, reply });
    }
    if (client.permission !== undefined) {
      return await client.permission.reply({ requestID: request.id, reply });
    }
    throw new BotError(ErrorCode.PERMISSION_DENIED, 'OpenCode permission API is unavailable');
  }

  private isSdkErrorEnvelope(value: unknown): value is SdkErrorEnvelope {
    if (typeof value !== 'object' || value === null || !('error' in value)) {
      return false;
    }
    const result = value as { error?: unknown };
    return result.error !== null && result.error !== undefined;
  }
}
