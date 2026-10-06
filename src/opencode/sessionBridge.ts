import { createHash } from 'node:crypto';
import { AttachmentBuilder } from 'discord.js';
import type { FilePartInput, TextPartInput } from '@opencode-ai/sdk/v2';
import type { SessionState } from '../state/types.js';
import { suppressLinkPreviews } from '../discord/messageOptions.js';
import { BotError, ErrorCode } from '../utils/errors.js';
import { formatHistoryMessage, formatMarkdownTables, splitMessage } from '../utils/formatter.js';

type MaybeWrapped<T> = T | { data: T };
type SessionLike = { id?: string; sessionID?: string } | null | undefined;
type SdkErrorEnvelope = { error?: unknown };
type MessageLike = {
  id?: string;
  messageID?: string;
  role?: string;
  content?: string | Array<{ type?: string; text?: string; content?: string; synthetic?: boolean; time?: { created?: number; completed?: number }; state?: { status?: string; content?: Array<{ type?: string; uri?: string; mime?: string }> } }>;
  text?: string;
  type?: string;
  finish?: string;
  metadata?: { opencodeDiscordOrigin?: boolean };
  time?: { created?: number; streamed?: number; completed?: number };
  info?: { id?: string; messageID?: string; role?: string };
  parts?: Array<{ type?: string; text?: string; content?: string; synthetic?: boolean; time?: { created?: number; completed?: number }; state?: { status?: string; content?: Array<{ type?: string; uri?: string; mime?: string }> } }>;
};

/** Structural subset of StateManager used by the session bridge. */
export interface SessionStateManager {
  getSession(threadId: string): SessionState | undefined;
  setSession(threadId: string, session: SessionState): void;
}

/** Structural OpenCode SDK v2 session client used by the session bridge. */
export interface OpencodeSessionClient {
  session: {
    create(options: { title?: string }): Promise<MaybeWrapped<SessionLike>>;
    get(options: { sessionID: string }): Promise<MaybeWrapped<SessionLike>>;
    abort(options: { sessionID: string }): Promise<unknown>;
    messages(options: { sessionID: string; limit?: number }): Promise<unknown>;
    promptAsync(options: {
      sessionID: string;
      parts: Array<TextPartInput | FilePartInput>;
      agent: string;
      model?: { providerID?: string; modelID: string };
    }): Promise<unknown>;
  };
  v2Root?: {
    session: {
      messages(options: { sessionID: string; limit?: number; order?: 'asc' | 'desc'; cursor?: string }): Promise<unknown>;
      switchAgent(options: { sessionID: string; agent: string }): Promise<unknown>;
      switchModel(options: { sessionID: string; model?: { providerID: string; id: string } }): Promise<unknown>;
      prompt(options: { sessionID: string; text: string; delivery?: 'steer' | 'queue'; metadata?: { opencodeDiscordOrigin: boolean } }): Promise<unknown>;
    };
  };
}

/** Minimal stream subscriber contract implemented by the later stream handler task. */
export interface StreamSubscriber {
  subscribe(threadId: string, sessionId: string, client: OpencodeSessionClient, dedupeSet?: Set<string>): Promise<void> | void;
  startTypingForThread?(threadId: string): void;
  refreshTypingForThread?(threadId: string): void;
  stopTypingForThread?(threadId: string): void;
}

/** Constructor options for SessionBridge. */
export interface SessionBridgeOptions {
  stateManager: SessionStateManager;
  streamSubscriber: StreamSubscriber;
  now?: () => number;
  syncImages?: boolean;
}

/** Options for creating and mapping a new OpenCode session. */
export interface CreateSessionOptions {
  client: OpencodeSessionClient;
  threadId: string;
  guildId: string;
  channelId: string;
  projectPath: string;
  agent: string;
  model?: string | null;
  createdBy: string;
  title?: string;
}

/** File attachment prompt input. */
export interface PromptFile {
  url: string;
  mime: string;
  filename?: string;
}

/** Options for sending a prompt to a mapped session. */
export interface SendPromptOptions {
  client: OpencodeSessionClient;
  content: string;
  files?: PromptFile[];
  agent?: string;
  model?: string | null;
}

/** Minimal Discord thread-like history replay target. */
export interface HistoryThreadLike {
  send(content: string | { content: string; flags?: number; allowedMentions?: { parse: string[] }; files?: AttachmentBuilder[] }): Promise<unknown>;
  messages?: { fetch(options: { limit: number }): Promise<{ values(): Iterable<unknown> }> };
}

/** Options for connecting a Discord thread to an existing session. */
export interface ConnectToSessionOptions {
  client: OpencodeSessionClient;
  threadId: string;
  guildId: string;
  channelId: string;
  projectPath: string;
  sessionId: string;
  agent: string;
  model?: string | null;
  createdBy: string;
  historyLimit?: number;
  thread: HistoryThreadLike;
}

export interface ReplayOlderHistoryOptions extends ConnectToSessionOptions {
  count?: number;
}

/** Bridges Discord thread mappings to OpenCode SDK session operations. */
export class SessionBridge {
  private readonly stateManager: SessionStateManager;
  private readonly streamSubscriber: StreamSubscriber;
  private readonly now: () => number;
  private readonly syncImages: boolean;
  private readonly imagesEnabledAt: number;
  private readonly dedupeSets = new Map<string, Set<string>>();
  private readonly userBackfillChecked = new Set<string>();
  private readonly pendingReplays = new Map<string, Promise<void>>();

  /**
   * Create a session bridge.
   * @param options - Bridge dependencies and optional clock.
   */
  public constructor(options: SessionBridgeOptions) {
    this.stateManager = options.stateManager;
    this.streamSubscriber = options.streamSubscriber;
    this.now = options.now ?? Date.now;
    this.syncImages = options.syncImages ?? false;
    this.imagesEnabledAt = this.syncImages ? this.now() : 0;
  }

  /**
   * Create an OpenCode session and persist its Discord thread mapping.
   * @param options - Session creation and mapping details.
   * @returns Persisted session state.
   */
  public async createSession(options: CreateSessionOptions): Promise<SessionState> {
    const created = unwrap(await options.client.session.create({ title: options.title }));
    const sessionId = getSessionId(created);

    if (!sessionId) {
      throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'OpenCode did not return a session ID', { threadId: options.threadId });
    }

    if (options.client.v2Root) {
      const switched = await options.client.v2Root.session.switchAgent({ sessionID: sessionId, agent: options.agent });
      if (switched && typeof switched === 'object' && 'error' in switched && switched.error != null) {
        throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode 에이전트를 설정하지 못했습니다.', { sessionId });
      }
    }
    const state = this.buildSessionState(options, sessionId);
    this.stateManager.setSession(options.threadId, state);
    await this.refreshSubscription(options.threadId, sessionId, options.client);
    return state;
  }

  /**
   * Send a text prompt and optional files to a mapped session.
   * @param threadId - Discord thread ID mapped to the session.
   * @param options - Prompt content, files, and SDK client.
   * @returns Nothing.
   */
  public async sendPrompt(threadId: string, options: SendPromptOptions): Promise<void> {
    const session = this.requireActiveSession(threadId);
    const parts: Array<TextPartInput | FilePartInput> = [
      { type: 'text', text: options.content },
      ...(options.files ?? []).map((file) => ({ type: 'file' as const, mime: file.mime, url: file.url, filename: file.filename })),
    ];
    const model = parseModel(options.model ?? session.model);

    await this.verifySession(options.client, session.sessionId);
    await this.refreshSubscription(threadId, session.sessionId, options.client);
    let result: unknown;
    try {
      if (options.client.v2Root !== undefined && (options.files?.length ?? 0) === 0) {
        if (model.model !== undefined) {
          const switched = await options.client.v2Root.session.switchModel({
            sessionID: session.sessionId,
            model: { providerID: model.model.providerID ?? '', id: model.model.modelID },
          });
          if (switched && typeof switched === 'object' && 'error' in switched && switched.error != null) {
            throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode 모델을 설정하지 못했습니다.', { sessionId: session.sessionId });
          }
        }
        result = await options.client.v2Root.session.prompt({
          sessionID: session.sessionId,
          text: options.content,
          delivery: 'steer',
          metadata: { opencodeDiscordOrigin: true },
        });
      } else {
        result = await options.client.session.promptAsync({
          sessionID: session.sessionId,
          parts,
          agent: options.agent ?? session.agent,
          ...model,
        });
      }
    } catch (error) {
      this.streamSubscriber.stopTypingForThread?.(threadId);
      throw error;
    }
    assertNoSdkError(result, 'OpenCode prompt failed', { threadId, sessionId: session.sessionId });
    this.streamSubscriber.startTypingForThread?.(threadId);

    const promptMessageId = getResultMessageId(result);
    this.stateManager.setSession(threadId, {
      ...session,
      lastActivityAt: this.now(),
      ...(promptMessageId === undefined ? {} : { lastSyncedMessageId: promptMessageId, lastSyncedMessageContent: undefined }),
    });
  }

  /**
   * Connect a Discord thread to an existing OpenCode session and replay history.
   * @param options - Existing session and thread mapping details.
   * @returns Nothing.
   */
  public async connectToSession(options: ConnectToSessionOptions): Promise<void> {
    await this.verifySession(options.client, options.sessionId);

    const previous = this.stateManager.getSession(options.threadId);
    const state = this.buildSessionState(options, options.sessionId);
    if (previous?.sessionId === options.sessionId) {
      state.userMirrorSince = previous.userMirrorSince ?? state.userMirrorSince;
      state.lastSyncedUserMessageId = previous.lastSyncedUserMessageId;
      state.lastSyncedUserAt = previous.lastSyncedUserAt;
      state.imageMirrorSince = previous.imageMirrorSince;
      state.syncedImageHashes = previous.syncedImageHashes;
    }
    if (previous?.sessionId === options.sessionId && previous.lastSyncedMessageId) {
      state.lastSyncedMessageId = previous.lastSyncedMessageId;
      state.lastSyncedMessageContent = previous.lastSyncedMessageContent;
    }
    this.stateManager.setSession(options.threadId, state);

    const dedupeSet = this.getDedupeSet(options.threadId);
    await this.streamSubscriber.subscribe(options.threadId, options.sessionId, options.client, dedupeSet);
    const historyLimit = options.historyLimit === 0 ? undefined : options.historyLimit;

    if (historyLimit !== undefined) {
      try {
        await this.replayAndRemember(options, state, dedupeSet, { sessionID: options.sessionId, limit: historyLimit });
      } catch {
        // History replay is best-effort; connecting should still succeed.
      }
    }

    if (historyLimit === undefined) {
      try {
        await this.replayAndRemember(options, state, dedupeSet, { sessionID: options.sessionId });
      } catch {
        // Full history replay is best-effort.
      }
    }

    await options.thread.send(suppressLinkPreviews(`세션 \`${options.sessionId}\`에 연결했습니다.`));
  }

  /** Replay existing OpenCode messages into an already connected Discord thread. */
  public async replaySessionHistory(options: ConnectToSessionOptions): Promise<{ latestAssistantAt?: number }> {
    const previous = this.pendingReplays.get(options.threadId);
    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    this.pendingReplays.set(options.threadId, completed);
    try {
      await previous;
      await this.verifySession(options.client, options.sessionId);
      const dedupeSet = this.getDedupeSet(options.threadId);
      const state = this.stateManager.getSession(options.threadId);
      const replayed = await this.replayAndRemember(options, state, dedupeSet, {
        sessionID: options.sessionId,
        limit: options.historyLimit,
      });
      if (replayed.terminal) this.streamSubscriber.stopTypingForThread?.(options.threadId);
      else if (replayed.active || replayed.changed) this.streamSubscriber.refreshTypingForThread?.(options.threadId);
      return { latestAssistantAt: replayed.latestAssistantAt };
    } finally {
      release();
      if (this.pendingReplays.get(options.threadId) === completed) this.pendingReplays.delete(options.threadId);
    }
  }

  /** Return the shared SSE/history dedupe set for one Discord thread. */
  public getDedupeSet(threadId: string): Set<string> {
    const existing = this.dedupeSets.get(threadId);
    if (existing) return existing;
    const created = new Set<string>();
    this.dedupeSets.set(threadId, created);
    return created;
  }

  /** Replay messages older than the oldest message already synchronized. */
  public async replayOlderSessionHistory(options: ReplayOlderHistoryOptions): Promise<void> {
    await this.verifySession(options.client, options.sessionId);
    const state = this.stateManager.getSession(options.threadId);
    const messages = await this.loadOrderedMessages(options.client, options.sessionId);
    const markerIndex = state?.historyStartMessageId
      ? messages.findIndex((message) => getMessageId(message) === state.historyStartMessageId)
      : messages.length;
    const end = markerIndex >= 0 ? markerIndex : messages.length;
    const start = options.count === undefined ? 0 : Math.max(0, end - options.count);
    const older = messages.slice(start, end);
    await this.sendHistoryMessages(options.thread, older);
    const firstId = getMessageId(older[0] ?? {});
    if (state && firstId) {
      this.stateManager.setSession(options.threadId, { ...state, historyStartMessageId: firstId });
    }
  }

  private async replayAndRemember(
    options: ConnectToSessionOptions,
    state: SessionState | undefined,
    dedupeSet: Set<string>,
    request: { sessionID: string; limit?: number },
  ): Promise<{ terminal: boolean; changed: boolean; active: boolean; latestAssistantAt?: number }> {
    if (state && state.userMirrorSince === undefined) {
      state = { ...state, userMirrorSince: this.now() };
      this.stateManager.setSession(options.threadId, state);
    }
    const replayed = await this.replayMessages(
      options.client,
      options.thread,
      dedupeSet,
      request,
      options.threadId,
      state?.lastSyncedMessageId,
      state?.lastSyncedMessageContent,
      state?.userMirrorSince ?? this.now(),
      state?.lastSyncedUserMessageId,
      state?.lastSyncedUserAt,
      (message) => {
        const current = this.stateManager.getSession(options.threadId);
        if (current && message.id) this.stateManager.setSession(options.threadId, {
          ...current,
          lastSyncedUserMessageId: message.id,
          lastSyncedUserAt: message.time?.created,
        });
      },
    );
    if (state && replayed.latest) {
      this.stateManager.setSession(options.threadId, {
        ...(this.stateManager.getSession(options.threadId) ?? state),
        lastSyncedMessageId: replayed.latest,
        lastSyncedMessageContent: replayed.latestContent,
        historyStartMessageId: state.historyStartMessageId ?? replayed.earliest,
      });
    }
    return { terminal: replayed.terminal, changed: replayed.changed, active: replayed.active, latestAssistantAt: replayed.latestAssistantAt };
  }

  private async refreshSubscription(threadId: string, sessionId: string, client: OpencodeSessionClient): Promise<void> {
    await this.streamSubscriber.subscribe(threadId, sessionId, client, this.getDedupeSet(threadId));
  }

  /**
   * Abort a mapped OpenCode session through the SDK.
   * @param threadId - Discord thread ID mapped to the session.
   * @param client - OpenCode SDK client.
   * @returns Nothing.
   */
  public async abortSession(threadId: string, client: OpencodeSessionClient): Promise<void> {
    const session = this.requireActiveSession(threadId);
    const result = await client.session.abort({ sessionID: session.sessionId });
    assertNoSdkError(result, 'OpenCode abort failed', { threadId, sessionId: session.sessionId });
  }

  private buildSessionState(options: CreateSessionOptions | ConnectToSessionOptions, sessionId: string): SessionState {
    const timestamp = this.now();

    return {
      sessionId,
      guildId: options.guildId,
      channelId: options.channelId,
      projectPath: options.projectPath,
      agent: options.agent,
      model: options.model ?? null,
      createdBy: options.createdBy,
      createdAt: timestamp,
      lastActivityAt: timestamp,
      userMirrorSince: timestamp,
      status: 'active',
    };
  }

  private requireActiveSession(threadId: string): SessionState {
    const session = this.stateManager.getSession(threadId);

    if (!session || session.status === 'ended') {
      throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active OpenCode session is attached to this thread', { threadId });
    }

    return session;
  }

  private async verifySession(client: OpencodeSessionClient, sessionId: string): Promise<void> {
    try {
      const response: unknown = await client.session.get({ sessionID: sessionId });
      if (isRecord(response) && response.error != null) {
        const status = isRecord(response.response) ? response.response.status : undefined;
        throw new BotError(status === 404 ? ErrorCode.SESSION_NOT_FOUND : ErrorCode.SERVER_UNHEALTHY,
          status === 404 ? 'OpenCode 세션을 찾지 못했습니다.' : 'OpenCode 세션 조회에 실패했습니다.', { sessionId, status });
      }
      const session = unwrap(response as MaybeWrapped<SessionLike>);
      if (getSessionId(session) !== sessionId) {
        throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'OpenCode 세션을 찾지 못했습니다.', { sessionId });
      }
    } catch (error) {
      if (error instanceof BotError) {
        throw error;
      }

      throw new BotError(ErrorCode.SERVER_UNHEALTHY, 'OpenCode 세션 조회에 실패했습니다.', { sessionId });
    }
  }

  private async replayMessages(
    client: OpencodeSessionClient,
    thread: HistoryThreadLike,
    dedupeSet: Set<string>,
    options: { sessionID: string; limit?: number },
    threadId: string,
    afterMessageId?: string,
    afterMessageContent?: string,
    userMirrorSince = Number.POSITIVE_INFINITY,
    lastSyncedUserMessageId?: string,
    lastSyncedUserAt?: number,
    onUserHandled?: (message: MessageLike) => void,
  ): Promise<{ latest?: string; latestContent?: string; earliest?: string; terminal: boolean; changed: boolean; active: boolean; latestAssistantAt?: number }> {
    let orderedMessages = await this.loadOrderedMessages(client, options.sessionID, options.limit);
    let markerIndex = afterMessageId ? orderedMessages.findIndex((message) => getMessageId(message) === afterMessageId) : -1;
    let checkedUserBackfill = options.limit === undefined || options.limit >= 100;
    if (afterMessageId && markerIndex < 0 && options.limit !== undefined) {
      // ponytail: legacy message API caps one read at 100 and ignores its cursor; durable-event replay is the upgrade path.
      orderedMessages = await this.loadOrderedMessages(client, options.sessionID, 100);
      markerIndex = orderedMessages.findIndex((message) => getMessageId(message) === afterMessageId);
      checkedUserBackfill = true;
    }
    const latestVisibleId = getMessageId([...orderedMessages].reverse().find(isVisibleHistoryMessage) ?? {});
    const userMarkerMissing = !lastSyncedUserMessageId
      || !orderedMessages.some((message) => getMessageId(message) === lastSyncedUserMessageId);
    if (afterMessageId && options.limit !== undefined && options.limit < 100
      && (!this.userBackfillChecked.has(threadId) || (latestVisibleId !== afterMessageId && userMarkerMissing))) {
      // ponytail: one bounded backfill per startup; recheck 100 only after new activity outruns the 5-message window.
      orderedMessages = await this.loadOrderedMessages(client, options.sessionID, 100);
      markerIndex = orderedMessages.findIndex((message) => getMessageId(message) === afterMessageId);
      checkedUserBackfill = true;
    }
    // User delivery has its own durable cursor. The assistant marker can pass a user turn during SSE/poll races.
    const lastUserIndex = lastSyncedUserMessageId
      ? orderedMessages.findIndex((message) => getMessageId(message) === lastSyncedUserMessageId)
      : -1;
    await this.sendNewUserMessages(
      thread,
      orderedMessages.slice(lastUserIndex < 0 ? 0 : lastUserIndex + 1)
        .filter((message) => getMessageRole(message).toLowerCase() === 'user'
          && message.time?.created !== undefined && message.time.created >= userMirrorSince
          && (lastUserIndex >= 0 || lastSyncedUserAt === undefined || message.time.created > lastSyncedUserAt)),
      onUserHandled,
    );
    const imagesDelivered = this.syncImages && await this.sendImageMessages(threadId, thread, orderedMessages);
    if (checkedUserBackfill) this.userBackfillChecked.add(threadId);
    const marker = markerIndex >= 0 ? orderedMessages[markerIndex] : undefined;
    const pendingMessages = afterMessageId
      ? markerIndex >= 0
        ? orderedMessages.slice(marker !== undefined && markerHasContent(marker) && getMessageContent(marker) === afterMessageContent ? markerIndex + 1 : markerIndex)
        : []
      : orderedMessages;
    await this.sendHistoryMessages(thread, pendingMessages, dedupeSet);
    const markerMissing = afterMessageId !== undefined && markerIndex < 0;
    const latestMessage = [...orderedMessages].reverse().find((message) => isVisibleHistoryMessage(message) && (getMessageRole(message).toLowerCase() === 'user' || markerHasContent(message)));
    const latestLifecycleMessage = [...orderedMessages].reverse().find((message) => {
      const role = getMessageRole(message).toLowerCase();
      return isVisibleHistoryMessage(message) || role === 'idle' || role === 'error';
    });
    const latestId = markerMissing ? afterMessageId : getMessageId(latestMessage ?? {});
    const latestAssistant = [...orderedMessages].reverse().find((message) => getMessageRole(message).toLowerCase() === 'assistant' && markerHasContent(message));
    return {
      latest: latestId,
      latestContent: markerMissing ? afterMessageContent : latestMessage === undefined ? undefined : getMessageContent(latestMessage),
      earliest: getMessageId(pendingMessages[0] ?? orderedMessages[0] ?? {}),
      terminal: isTerminalHistoryMessage(latestLifecycleMessage),
      changed: imagesDelivered || latestId !== undefined && latestId !== afterMessageId,
      active: isActiveHistoryMessage(latestLifecycleMessage),
      latestAssistantAt: latestAssistant?.time?.completed ?? latestAssistant?.time?.streamed ?? latestAssistant?.time?.created,
    };
  }

  // ponytail: the v2 client returns an error envelope for session messages, so the
  // legacy route is the only working reader; it always answers newest-first and has no cursor.
  private async loadOrderedMessages(client: OpencodeSessionClient, sessionId: string, limit?: number): Promise<MessageLike[]> {
    const response: unknown = await client.session.messages(limit === undefined ? { sessionID: sessionId } : { sessionID: sessionId, limit });
    const envelope = response && typeof response === 'object' && 'data' in response ? response.data : response;
    const messages = Array.isArray(envelope)
      ? envelope
      : isRecord(envelope) && Array.isArray(envelope.data)
        ? envelope.data
        : [];
    return [...(messages as MessageLike[])].reverse();
  }

  private async sendNewUserMessages(thread: HistoryThreadLike, messages: MessageLike[], onHandled?: (message: MessageLike) => void): Promise<void> {
    let discordMessages: unknown[] | undefined;
    for (const message of messages) {
      const content = getMessageContent(message);
      if (content && message.metadata?.opencodeDiscordOrigin !== true && thread.messages) {
        discordMessages ??= [...(await thread.messages.fetch({ limit: 100 })).values()];
      }
      const firstChunk = splitMessage(formatHistoryMessage('user', content))[0];
      // ponytail: legacy prompts lack origin metadata. The recent-100 text/time check can miss an identical CLI prompt.
      const alreadyInDiscord = discordMessages?.some((raw) => isRecord(raw) && isRecord(raw.author)
        && typeof raw.createdTimestamp === 'number' && message.time?.created !== undefined
        && ((raw.author.bot === false && raw.content === content && message.time.created >= raw.createdTimestamp
          && message.time.created - raw.createdTimestamp < 60_000)
          || (raw.author.bot === true && (raw.content === firstChunk || raw.content === firstChunk?.replace('**나:**', '**User:**'))
            && raw.createdTimestamp >= message.time.created))) ?? false;
      if (content && message.metadata?.opencodeDiscordOrigin !== true && !alreadyInDiscord) {
        for (const chunk of splitMessage(formatHistoryMessage('user', content))) {
          await thread.send(suppressLinkPreviews({ content: chunk, allowedMentions: { parse: [] } }));
        }
      }
      onHandled?.(message);
    }
  }

  private async sendImageMessages(threadId: string, thread: HistoryThreadLike, messages: MessageLike[]): Promise<boolean> {
    const session = this.stateManager.getSession(threadId);
    if (!session) return false;
    const since = session.imageMirrorSince ?? this.imagesEnabledAt;
    if (session.imageMirrorSince === undefined) this.stateManager.setSession(threadId, { ...session, imageMirrorSince: since });
    const sent = new Set(session.syncedImageHashes ?? []);
    let delivered = false;
    for (const message of messages) {
      if (getMessageRole(message) !== 'assistant') continue;
      for (const part of Array.isArray(message.content) ? message.content : message.parts ?? []) {
        if (part.type !== 'tool' || part.state?.status !== 'completed') continue;
        if ((part.time?.completed ?? part.time?.created ?? message.time?.created ?? 0) < since) continue;
        for (const file of part.state.content ?? []) {
          if (file.type !== 'file' || typeof file.uri !== 'string') continue;
          const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(file.uri);
          if (!match || file.mime !== `image/${match[1]?.toLowerCase()}`) continue;
          const hash = createHash('sha256').update(file.uri).digest('hex');
          if (sent.has(hash)) continue;
          const bytes = Buffer.from(match[2] ?? '', 'base64');
          if (bytes.length === 0) continue;
          // ponytail: 8 MiB attachment ceiling; resize upstream when larger images become common.
          if (bytes.length > 8 * 1024 * 1024) {
            await thread.send('OpenCode 이미지가 8 MiB를 초과해 Discord에 첨부하지 못했습니다.');
          } else {
            const extension = match[1]?.toLowerCase() === 'jpeg' ? 'jpg' : match[1]?.toLowerCase();
            await thread.send({ content: '', files: [new AttachmentBuilder(bytes, { name: `opencode-${hash.slice(0, 12)}.${extension}` })], allowedMentions: { parse: [] } });
          }
          sent.add(hash);
          const current = this.stateManager.getSession(threadId);
          if (!current || current.sessionId !== session.sessionId) return delivered;
          // ponytail: stored hashes grow with distinct images; use a durable image cursor when sessions reach thousands of images.
          this.stateManager.setSession(threadId, { ...current, syncedImageHashes: [...sent] });
          delivered = true;
        }
      }
    }
    return delivered;
  }

  private async sendHistoryMessages(thread: HistoryThreadLike, messages: MessageLike[], dedupeSet = new Set<string>()): Promise<void> {
    for (const message of messages) {
      if (getMessageRole(message).toLowerCase() !== 'assistant') continue;
      const messageId = getMessageId(message);
      if (messageId && dedupeSet.has(messageId)) continue;
      const content = getMessageContent(message);
      if (!content.trim()) continue;
      for (const chunk of splitMessage(formatMarkdownTables(formatHistoryMessage('assistant', content)))) {
        if (!chunk.trim()) continue;
        await thread.send(suppressLinkPreviews(chunk));
      }
      if (messageId) dedupeSet.add(messageId);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function unwrap<T>(value: MaybeWrapped<T>): T {
  let current: unknown = value;
  while (current && typeof current === 'object' && 'data' in current) {
    current = (current as { data: unknown }).data;
  }

  return current as T;
}

function getSessionId(session: SessionLike): string | undefined {
  return session?.id ?? session?.sessionID;
}

function parseModel(model: string | null | undefined): { model?: { providerID?: string; modelID: string } } {
  if (!model) {
    return {};
  }

  const separatorIndex = model.indexOf('/');
  if (separatorIndex === -1) {
    throw new BotError(ErrorCode.MODEL_NOT_FOUND, 'Model must include a provider ID', { model });
  }

  return {
    model: {
      providerID: model.slice(0, separatorIndex),
      modelID: model.slice(separatorIndex + 1),
    },
  };
}

function getMessageId(message: MessageLike): string | undefined {
  return message.info?.id ?? message.info?.messageID ?? message.id ?? message.messageID;
}

function getResultMessageId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id === 'string') return value.id;
  return isRecord(value.data) ? getResultMessageId(value.data) : undefined;
}

function getMessageRole(message: MessageLike): string {
  return message.info?.role ?? message.role ?? message.type ?? 'assistant';
}

function isVisibleHistoryMessage(message: MessageLike): boolean {
  const role = getMessageRole(message).toLowerCase();
  return role === 'user' || role === 'assistant';
}

function isTerminalHistoryMessage(message: MessageLike | undefined): boolean {
  if (message === undefined) return false;
  const role = getMessageRole(message).toLowerCase();
  return role === 'idle' || role === 'error' || (role === 'assistant' && message.finish !== undefined && message.finish !== 'tool-calls');
}

function isActiveHistoryMessage(message: MessageLike | undefined): boolean {
  if (message === undefined || getMessageRole(message).toLowerCase() !== 'assistant' || message.finish !== undefined) return false;
  const parts = Array.isArray(message.content) ? message.content : message.parts ?? [];
  return parts.some((part) => part.type === 'tool' && part.state?.status === 'running');
}

function getMessageContent(message: MessageLike): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => (part.type === 'text' || part.type === 'reasoning') && part.synthetic !== true)
      .map((part) => part.text ?? part.content ?? '')
      .filter(Boolean)
      .join('\n');
  }

  if (typeof message.text === 'string') {
    return message.text;
  }

  return (message.parts ?? [])
    .filter((part) => (!part.type || part.type === 'text' || part.type === 'reasoning') && part.synthetic !== true)
    .map((part) => part.text ?? part.content ?? '')
    .filter(Boolean)
    .join('\n');
}

function markerHasContent(message: MessageLike | undefined): boolean {
  return message !== undefined && getMessageContent(message).length > 0;
}

function assertNoSdkError(result: unknown, message: string, context: Record<string, unknown>): void {
  if (result && typeof result === 'object' && 'error' in result && (result as SdkErrorEnvelope).error) {
    throw new BotError(ErrorCode.SESSION_NOT_FOUND, message, { ...context, sdkError: (result as SdkErrorEnvelope).error });
  }
}
