import { detectTable, splitMessage } from '../utils/formatter.js';
import { createLogger } from '../utils/logger.js';
import { suppressLinkPreviews } from '../discord/messageOptions.js';

const logger = createLogger('StreamHandler');

/** Legacy question request shape produced from a CLI v2 form. */
interface FormQuestionRequest {
  id: string;
  sessionID: string;
  questions: { header: string; question: string; options: { label: string; description: string; value: string }[]; multiple: boolean; custom: boolean }[];
  keys: string[];
}

/** OpenCode global event shape used by the stream handler. */
export interface GlobalEventLike {
  directory?: string;
  payload: {
    type: string;
    sessionID?: string;
    messageID?: string;
    partID?: string;
    delta?: string;
    field?: string;
    messageRole?: string;
    status?: string;
    part?: Record<string, unknown>;
    info?: unknown;
    request?: unknown;
    error?: unknown;
    todos?: unknown[];
    properties?: Record<string, unknown>;
  };
}

/** OpenCode client subset required for SSE streaming. */
export interface OpenCodeStreamClient {
  global: {
    event(): OpenCodeEventSource | Promise<OpenCodeEventSource>;
  };
  event?: {
    subscribe(): OpenCodeEventSource | Promise<OpenCodeEventSource>;
  };
  v2Root?: {
    global?: {
      event(): OpenCodeEventSource | Promise<OpenCodeEventSource>;
    };
    event: {
      subscribe(options?: { directory?: string }): OpenCodeEventSource | Promise<OpenCodeEventSource>;
    };
  };
}

export type OpenCodeEventSource = AsyncIterable<unknown> | { stream: AsyncIterable<unknown> };

/** Editable Discord message subset required by streaming. */
export interface StreamMessage {
  /**
   * Edit the current Discord message content.
   * @param content - Updated message content.
   * @returns Discord API edit result.
   */
  edit(content: string | { content: string; flags: number }): Promise<unknown>;
}

/** Discord thread subset required by streaming. */
export interface StreamThread {
  name?: string;
  /**
   * Send a new Discord message to the thread.
   * @param content - Message content to send.
   * @returns Message that can be edited while streaming continues.
   */
  send(content: string | { content: string; flags: number }): Promise<StreamMessage>;

  /**
   * Send a typing indicator to the thread.
   * @returns Completion once Discord accepts the typing indicator.
   */
  sendTyping?(): Promise<void>;
  setName?(name: string): Promise<unknown>;
}

/** Delegate for OpenCode question events. */
export interface QuestionEventDelegate {
  /**
   * Handle a question request from OpenCode.
   * @param threadId - Discord thread ID receiving the stream.
   * @param event - OpenCode question payload.
   * @param client - OpenCode client for replies.
   * @returns Completion once the event is handled.
   */
  handleQuestionEvent(threadId: string, event: unknown, client: OpenCodeStreamClient): Promise<void>;

  /**
   * Clear a pending question answered outside Discord, such as a CLI v2 form reply.
   * @param threadId - Discord thread ID whose pending question is settled.
   */
  handleQuestionSettled?(threadId: string): void;
}

/** Delegate for OpenCode permission events. */
export interface PermissionEventDelegate {
  /**
   * Handle a permission request from OpenCode.
   * @param threadId - Discord thread ID receiving the stream.
   * @param event - OpenCode permission payload.
   * @param client - OpenCode client for replies.
   * @returns Completion once the event is handled.
   */
  handlePermissionEvent(threadId: string, event: unknown, client: OpenCodeStreamClient): Promise<void>;
}

/** Delegate for detected markdown tables. */
export interface TableEventDelegate {
  /**
   * Handle detected table markdown.
   * @param threadId - Discord thread ID receiving the stream.
   * @param markdown - Current streamed markdown containing a table.
   * @returns Completion once the table is handled.
   */
  handleTable(threadId: string, markdown: string): Promise<void>;
}

/** Delegate for auto-connecting newly created OpenCode sessions. */
export interface AutoConnectDelegate {
  /**
   * Check whether a session is already attached to a Discord thread.
   * @param sessionId - OpenCode session ID.
   * @returns True when the session already has a thread mapping.
   */
  isSessionAttached(sessionId: string): boolean;

  /**
   * Handle a newly created OpenCode session for a project.
   * @param projectPath - OpenCode project directory.
   * @param session - Session payload from the OpenCode event.
   * @param client - OpenCode client associated with the stream.
   * @returns Completion once the session is connected or ignored by the delegate.
   */
  handleSessionCreated(projectPath: string, session: unknown, client: OpenCodeStreamClient): Promise<void>;

  /**
   * Recover sessions that may have been missed while SSE was disconnected.
   * @param projectPath - OpenCode project directory.
   * @param client - OpenCode client associated with the stream.
   * @returns Completion once missed sessions are checked.
   */
  recoverMissedSessions?(projectPath: string, client: OpenCodeStreamClient): Promise<void>;
}

/** Options for constructing a stream handler. */
export interface StreamHandlerOptions {
  /**
   * Resolve a Discord thread by ID.
   * @param threadId - Discord thread ID.
   * @returns Thread when available, otherwise undefined.
   */
  getThread(threadId: string): StreamThread | undefined;
  getEventClient?: (client: OpenCodeStreamClient, projectPath?: string) => OpenCodeStreamClient;
  questionHandler: QuestionEventDelegate;
  permissionHandler: PermissionEventDelegate;
  onUserMessage?: (threadId: string) => Promise<void> | void;
  autoConnectHandler?: AutoConnectDelegate;
  tableHandler?: TableEventDelegate;
  editThrottleMs?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxRetries?: number;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/** Live runtime state for a Discord thread's OpenCode stream subscription. */
export type StreamSubscriptionRuntimeState = 'streaming' | 'retrying' | 'idle' | 'disconnected';

/** Read-only live stream telemetry exposed to diagnostics commands. */
export interface StreamSubscriptionStatus {
  threadId: string;
  sessionId: string;
  projectPath?: string;
  state: StreamSubscriptionRuntimeState;
  failures: number;
  lastEventAt?: number;
  lastErrorAt?: number;
  lastDisconnectAt?: number;
}

interface SubscriptionState {
  cancelled: boolean;
  pumpPromise: Promise<void>;
  typingInterval?: ReturnType<typeof setInterval>;
  typingRepulseTimeout?: ReturnType<typeof setTimeout>;
  typingLastActivityAt?: number;
  retryWake?: () => void;
  threadId: string;
  sessionId: string;
  projectPath?: string;
  runtimeState: StreamSubscriptionRuntimeState;
  context?: ReturnType<StreamHandler['createContext']>;
  failures: number;
  lastEventAt?: number;
  lastErrorAt?: number;
  lastDisconnectAt?: number;
  sharedStream?: SharedStream;
}

interface SharedStream {
  client: OpenCodeStreamClient;
  projectPath?: string;
  threadIds: Set<string>;
  contexts: Map<string, unknown>;
  cancelled: boolean;
  promise: Promise<void>;
  retryWake?: () => void;
}

const DEFAULT_EDIT_THROTTLE_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const TYPING_REFRESH_MS = 7000;
const TYPING_REPULSE_MS = 500;
const MAX_SUMMARY_DETAILS = 3;

/** Streams OpenCode SSE events into Discord thread messages. */
export class StreamHandler {
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private readonly sharedStreams = new Map<OpenCodeStreamClient, SharedStream>();
  private readonly editThrottleMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  /**
   * Create a stream handler.
   * @param options - Stream handler dependencies and timing configuration.
   * @returns StreamHandler instance.
   */
  constructor(private readonly options: StreamHandlerOptions) {
    this.editThrottleMs = options.editThrottleMs ?? DEFAULT_EDIT_THROTTLE_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? clearTimeout;
  }

  /**
   * Subscribe a Discord thread to OpenCode SSE events for a session.
   * @param threadId - Discord thread ID to update.
   * @param sessionId - OpenCode session ID to filter.
   * @param client - OpenCode client exposing global events.
   * @param dedupeSet - Optional streamed message dedupe set accepted by SessionBridge.
   * @param projectPath - Optional project directory to filter stream events.
   * @returns Completion once the background stream pump is started.
   */
  async subscribe(
    threadId: string,
    sessionId: string,
    client: OpenCodeStreamClient,
    dedupeSet?: Set<string>,
    projectPath?: string,
  ): Promise<void> {
    const thread = this.options.getThread(threadId);
    if (!thread) {
      logger.warn('Cannot subscribe without Discord thread', { threadId, sessionId });
      return;
    }

    logger.info('Discord 스레드와 OpenCode 이벤트 연결', { threadId, sessionId });

    const previous = this.subscriptions.get(threadId);
    if (previous !== undefined) {
      previous.cancelled = true;
      this.stopTyping(previous);
      const previousShared = previous.sharedStream;
      previousShared?.threadIds.delete(threadId);
      previousShared?.contexts.delete(threadId);
      if (previousShared && previousShared.threadIds.size === 0) {
        previousShared.cancelled = true;
        previousShared.retryWake?.();
      }
    }

    const state: SubscriptionState = {
      cancelled: false,
      pumpPromise: Promise.resolve(),
      threadId,
      sessionId,
      projectPath,
      runtimeState: 'idle',
      failures: 0,
    };
    this.subscriptions.set(threadId, state);
    const context = this.createContext(threadId, sessionId, client, thread, state, dedupeSet, projectPath);
    const eventClient = this.options.getEventClient?.(client, projectPath) ?? client;
    const existingShared = this.sharedStreams.get(eventClient);
    const shared = existingShared !== undefined && !existingShared.cancelled
      ? existingShared
      : this.createSharedStream(eventClient, eventClient === client ? projectPath : undefined);
    shared.threadIds.add(threadId);
    shared.contexts.set(threadId, context);
    state.context = context;
    state.sharedStream = shared;
    state.pumpPromise = shared.promise;
  }

  /**
   * Wait for the current stream pump to finish, useful for finite test streams.
   * @param threadId - Discord thread ID to wait for.
   * @returns Completion once the current pump settles.
   */
  async waitForIdle(threadId: string): Promise<void> {
    await this.subscriptions.get(threadId)?.pumpPromise;
  }

  /**
   * Rename a subscribed Discord thread to match the OpenCode session title.
   * Used by the poller because the CLI v2 event stream omits session.updated.
   * @param threadId - Discord thread ID mapped to the session.
   * @param title - OpenCode session title.
   */
  async renameThreadToTitle(threadId: string, title: string | undefined): Promise<void> {
    const context = this.subscriptions.get(threadId)?.context;
    if (context === undefined) {
      return;
    }
    await this.renameThread(context, title);
  }

  /** Start Discord's typing indicator for a thread. */
  startTypingForThread(threadId: string): void {
    const state = this.subscriptions.get(threadId);
    const context = state?.context;
    if (state !== undefined && context !== undefined) {
      state.runtimeState = 'streaming';
      this.beginTyping(context.thread, state, state.threadId, state.sessionId);
    }
  }

  /** Stop Discord's typing indicator for a thread. */
  stopTypingForThread(threadId: string): void {
    const state = this.subscriptions.get(threadId);
    if (state !== undefined) {
      state.runtimeState = 'idle';
      this.stopTyping(state);
    }
  }

  /** Refresh typing activity only when this thread is already typing. */
  refreshTypingForThread(threadId: string): void {
    const state = this.subscriptions.get(threadId);
    const context = state?.context;
    if (state !== undefined && context !== undefined) {
      state.runtimeState = 'streaming';
      this.beginTyping(context.thread, state, state.threadId, state.sessionId);
    }
  }

  /**
   * Stop processing future events for a thread.
   * @param threadId - Discord thread ID to unsubscribe.
   * @returns Nothing.
   */
  unsubscribe(threadId: string): void {
    const state = this.subscriptions.get(threadId);
    if (state) {
      state.cancelled = true;
      this.stopTyping(state);
      state.retryWake?.();
      const shared = state.sharedStream;
      shared?.threadIds.delete(threadId);
      shared?.contexts.delete(threadId);
      if (shared && shared.threadIds.size === 0) {
        shared.cancelled = true;
        shared.retryWake?.();
      }
    }
    this.subscriptions.delete(threadId);
  }

  /**
   * Get live stream telemetry for a Discord thread.
   * @param threadId - Discord thread ID to inspect.
   * @returns Stream status when a subscription exists.
   */
  getStatus(threadId: string): StreamSubscriptionStatus | undefined {
    const state = this.subscriptions.get(threadId);
    return state ? toSubscriptionStatus(state) : undefined;
  }

  /**
   * Get live stream telemetry for all subscriptions.
   * @returns Current stream statuses.
   */
  getStatuses(): StreamSubscriptionStatus[] {
    return [...this.subscriptions.values()].map(toSubscriptionStatus);
  }

  /**
   * Recover sessions that may have been missed outside the live SSE stream.
   * @param projectPath - OpenCode project directory to recover.
   * @param client - OpenCode client associated with the project.
   * @returns Completion once recovery is delegated or skipped.
   */
  async recoverMissedSessions(projectPath: string, client: OpenCodeStreamClient): Promise<void> {
    if (!this.options.autoConnectHandler?.recoverMissedSessions) {
      return;
    }

    try {
      await this.options.autoConnectHandler.recoverMissedSessions(projectPath, client);
    } catch (error) {
      logger.warn('Failed to recover missed auto-connect sessions', { projectPath, error });
    }
  }

  private beginTyping(thread: StreamThread, state: SubscriptionState, threadId: string, sessionId: string): void {
    state.typingLastActivityAt = Date.now();
    if (!thread.sendTyping || state.typingInterval !== undefined) {
      return;
    }

    void this.safeSendTyping(thread, threadId, sessionId);
    state.typingInterval = setInterval(() => {
      void this.safeSendTyping(thread, threadId, sessionId);
    }, TYPING_REFRESH_MS);
  }

  private stopTyping(state: SubscriptionState): void {
    if (state.typingInterval !== undefined) {
      clearInterval(state.typingInterval);
      state.typingInterval = undefined;
    }
    if (state.typingRepulseTimeout !== undefined) {
      this.clearTimeoutFn(state.typingRepulseTimeout);
      state.typingRepulseTimeout = undefined;
    }
    state.typingLastActivityAt = undefined;
  }

  private requestTypingRepulse(context: ReturnType<StreamHandler['createContext']>): void {
    const { state } = context;
    if (state.runtimeState !== 'streaming' || !context.thread.sendTyping) return;
    if (state.typingRepulseTimeout !== undefined) this.clearTimeoutFn(state.typingRepulseTimeout);
    state.typingRepulseTimeout = this.setTimeoutFn(() => {
      state.typingRepulseTimeout = undefined;
      if (state.runtimeState === 'streaming') {
        void this.safeSendTyping(context.thread, context.threadId, context.sessionId);
      }
    }, TYPING_REPULSE_MS);
  }

  private async safeSendTyping(thread: StreamThread, threadId: string, sessionId: string): Promise<void> {
    try {
      await thread.sendTyping?.();
      logger.info('Discord typing pulse 완료', { threadId, sessionId });
    } catch (error) {
      logger.warn('Failed to refresh Discord typing indicator', { threadId, sessionId, error });
    }
  }

  private async safeSend(thread: StreamThread, content: string, threadId: string, sessionId: string): Promise<void> {
    try {
      await thread.send(suppressLinkPreviews(content));
    } catch (error) {
      logger.warn('Failed to send stream recovery notice', { threadId, sessionId, error });
    }
  }

  private createContext(
    threadId: string,
    sessionId: string,
    client: OpenCodeStreamClient,
    thread: StreamThread,
    state: SubscriptionState,
    dedupeSet: Set<string> | undefined,
    projectPath: string | undefined,
  ) {
    return {
      threadId,
      sessionId,
      client,
      thread,
      state,
      dedupeSet,
      projectPath,
      aggregate: '',
      parts: new Map<string, string>(),
      partTypes: new Map<string, { type: string; synthetic: boolean }>(),
      messageRoles: new Map<string, string>(),
      currentMessageId: undefined as string | undefined,
      currentMessage: undefined as StreamMessage | undefined,
      sentChunks: 0,
      lastEditAt: Number.NEGATIVE_INFINITY,
      lastRenderedContent: undefined as string | undefined,
      runningTools: new Map<string, string>(),
      terminalTools: new Map<string, { tool: string; command?: string }>(),
      todosPrinted: false,
      tableDetected: false,
      idleMessageId: undefined as string | undefined,
    };
  }

  private async handleEvent(context: ReturnType<StreamHandler['createContext']>, event: GlobalEventLike): Promise<void> {
    const { payload } = event;
    if (context.projectPath && event.directory && event.directory !== context.projectPath) {
      return;
    }
    const eventSessionId = getSessionId(payload);
    if (payload.type !== 'session.created' && eventSessionId !== undefined && eventSessionId !== context.sessionId) {
      return;
    }
    if (payload.type.startsWith('message.') || payload.type.startsWith('session.') || payload.type.startsWith('tool.')) {
      logger.info('OpenCode 이벤트 수신', { threadId: context.threadId, sessionId: context.sessionId, type: payload.type });
    }

    if (payload.type === 'session.created') {
      await this.handleSessionCreated(context, event);
      return;
    }

    if (payload.type === 'session.updated') {
      if (getSessionId(payload) === context.sessionId) {
        await this.renameThread(context, getSessionTitle(payload));
      }
      return;
    }

    if (payload.type === 'session.execution.started') {
      if (getSessionId(payload) === context.sessionId) {
        context.state.runtimeState = 'streaming';
        logger.info('Discord typing 시작 요청', { threadId: context.threadId, sessionId: context.sessionId });
        this.beginTyping(context.thread, context.state, context.threadId, context.sessionId);
      }
      return;
    }

    if (payload.type === 'session.step.started' || payload.type === 'session.next.step.started') {
      if (getSessionId(payload) === context.sessionId) {
        await this.options.onUserMessage?.(context.threadId);
      }
      return;
    }

    if (payload.type === 'session.idle' || isTerminalExecutionEvent(payload.type)) {
      if (getSessionId(payload) === context.sessionId) {
        context.runningTools.clear();
        context.terminalTools.clear();
        await this.render(context, true);
        this.stopTyping(context.state);
        context.idleMessageId = context.currentMessageId;
      }
      return;
    }

    if (payload.type === 'session.error') {
      if (getSessionId(payload) === context.sessionId) {
        await this.handleTerminalSessionEvent(context);
      }
      return;
    }

    if (payload.type === 'session.status') {
      if (getSessionId(payload) === context.sessionId && isTerminalSessionStatus(getPayloadString(payload, 'status'))) {
        await this.handleTerminalSessionEvent(context);
      }
      return;
    }

    if (payload.type === 'session.tool.input.started') {
      const id = getPayloadString(payload, 'id');
      const tool = getPayloadString(payload, 'name')?.toLowerCase();
      if (id && (tool === 'shell' || tool === 'bash')) context.terminalTools.set(id, { tool });
      return;
    }

    if (payload.type === 'session.tool.called') {
      const id = getPayloadString(payload, 'id');
      const tracked = id && context.terminalTools.get(id);
      if (tracked) tracked.command = getRecordString(getPayloadRecord(payload, 'input') ?? {}, 'command');
      return;
    }

    if (payload.type === 'session.tool.success' || payload.type === 'session.tool.error'
      || payload.type === 'session.tool.failed' || payload.type === 'session.tool.failure') {
      const id = getPayloadString(payload, 'id');
      const tracked = id && context.terminalTools.get(id);
      if (id) context.terminalTools.delete(id);
      if (tracked) {
        const exit = getPayloadRecord(payload, 'metadata')?.exit;
        const status = payload.type !== 'session.tool.success' || typeof exit === 'number' && exit !== 0 ? 'error' : 'completed';
        await this.sendToolResult(context, { tool: tracked.tool, state: { input: { command: tracked.command } } }, status);
      }
      return;
    }

    if (payload.type === 'message.updated') {
      if (getSessionId(payload) !== context.sessionId) return;
      const info = getPayloadRecord(payload, 'info');
      const messageId = info && typeof info.id === 'string' ? info.id : getMessageId(payload);
      const role = info && (typeof info.role === 'string' ? info.role : typeof info.type === 'string' ? info.type : undefined);
      if (messageId && role) context.messageRoles.set(messageId, role);
      if (role === 'user' && (!info || !isRecord(info.metadata) || info.metadata.opencodeDiscordOrigin !== true)) {
        await this.options.onUserMessage?.(context.threadId);
      }
      return;
    }

    if (isSessionScopedEvent(payload.type)) {
      if (getSessionId(payload) !== context.sessionId) {
        return;
      }
      // ponytail: subscribed-but-idle sessions must stay pollable; only real turn traffic is 'streaming'.
      context.state.runtimeState = 'streaming';
    }

    if (payload.type === 'message.part.delta') {
      if (context.idleMessageId !== undefined && getMessageId(payload) === context.idleMessageId) {
        return;
      }
      await this.switchMessageContext(context, payload);
      await this.handleTextDelta(context, payload);
      return;
    }

    if (payload.type === 'message.part.updated') {
      await this.switchMessageContext(context, payload);
      await this.handlePartUpdated(context, payload);
      return;
    }

    if (payload.type === 'todo.updated') {
      await this.handleTodoUpdated(context, payload);
      return;
    }

    if (payload.type === 'question.asked' || payload.type === 'form.created') {
      this.stopTyping(context.state);
      const request = payload.type === 'form.created' ? toFormQuestionRequest(payload) : undefined;
      if (payload.type === 'form.created' && request === undefined) {
        logger.warn('Ignoring malformed form.created event', { threadId: context.threadId, sessionId: context.sessionId });
        return;
      }
      await this.options.questionHandler.handleQuestionEvent(
        context.threadId,
        request ?? getPayloadProperties(payload) ?? payload,
        context.client,
      );
      return;
    }

    if (payload.type === 'form.replied') {
      this.options.questionHandler.handleQuestionSettled?.(context.threadId);
      return;
    }

    if (payload.type === 'permission.asked') {
      this.stopTyping(context.state);
      const request = getPayloadProperties(payload) ?? payload;
      await this.options.permissionHandler.handlePermissionEvent(context.threadId, request, context.client);
    }
  }

  private async handleTerminalSessionEvent(context: ReturnType<StreamHandler['createContext']>): Promise<void> {
    context.state.runtimeState = 'idle';
    context.runningTools.clear();
    context.terminalTools.clear();
    await this.render(context, true);
    this.stopTyping(context.state);
    context.idleMessageId = context.currentMessageId;
  }

  private createSharedStream(client: OpenCodeStreamClient, projectPath?: string): SharedStream {
    const shared: SharedStream = {
      client,
      projectPath,
      threadIds: new Set(),
      contexts: new Map(),
      cancelled: false,
      promise: Promise.resolve(),
    };
    this.sharedStreams.set(client, shared);
    shared.promise = this.pumpShared(shared).finally(() => {
      if (this.sharedStreams.get(client) === shared) {
        this.sharedStreams.delete(client);
      }
    });
    return shared;
  }

  private async pumpShared(shared: SharedStream): Promise<void> {
    let failures = 0;
    while (!shared.cancelled) {
      let receivedEvent = false;
      try {
        const reconnecting = failures > 0;
        const source = shared.client.v2Root?.event?.subscribe
          ? shared.client.v2Root.event.subscribe(shared.projectPath === undefined ? undefined : { directory: shared.projectPath })
          : shared.client.global.event
            ? shared.client.global.event()
            : shared.client.v2Root?.global?.event
              ? shared.client.v2Root.global.event()
              : shared.client.event?.subscribe
                ? shared.client.event.subscribe()
                : undefined;
        if (source === undefined) {
          throw new Error('OpenCode event stream is unavailable');
        }
        const events = getEventStream(await source);
        if (reconnecting) {
          const projects = new Set([...shared.contexts.values()]
            .map((context) => (context as ReturnType<StreamHandler['createContext']>).projectPath)
            .filter((path): path is string => path !== undefined));
          for (const projectPath of projects) await this.recoverMissedSessions(projectPath, shared.client);
        }
        for await (const event of events) {
          if (shared.cancelled) return;
          receivedEvent = true;
          failures = 0;
          for (const threadId of [...shared.threadIds]) {
            const context = shared.contexts.get(threadId) as ReturnType<StreamHandler['createContext']> | undefined;
            if (!context || context.state.cancelled) continue;
            try {
              await this.handleEvent(context, event);
            } catch (error) {
              await this.safeRender(context);
              logger.warn('Shared stream event handling failed', { threadId, sessionId: context.sessionId, error });
            }
          }
        }
        for (const threadId of shared.threadIds) {
          const state = this.subscriptions.get(threadId);
          if (state) {
            state.runtimeState = receivedEvent ? 'idle' : 'retrying';
            state.lastEventAt = receivedEvent ? this.now() : state.lastEventAt;
          }
        }
        if (receivedEvent) {
          for (const threadId of [...shared.threadIds]) {
            const context = shared.contexts.get(threadId) as ReturnType<StreamHandler['createContext']> | undefined;
            if (context && !context.state.cancelled) {
              await this.render(context, true);
            }
          }
          return;
        }
        failures += 1;
        for (const threadId of shared.threadIds) {
          const state = this.subscriptions.get(threadId);
          if (state) {
            state.runtimeState = 'retrying';
            state.failures = failures;
          }
        }
      } catch (error) {
        failures += 1;
        for (const threadId of shared.threadIds) {
          const state = this.subscriptions.get(threadId);
          if (state) {
            state.runtimeState = 'retrying';
            state.failures = failures;
            state.lastErrorAt = this.now();
          }
        }
        logger.warn('Shared OpenCode stream failed', { error, failures });
      }
      if (shared.cancelled) return;
      if (failures > this.maxRetries) {
        for (const threadId of shared.threadIds) {
          const state = this.subscriptions.get(threadId);
          if (state) {
            state.runtimeState = 'disconnected';
            state.lastDisconnectAt = this.now();
          }
          const context = shared.contexts.get(threadId) as ReturnType<StreamHandler['createContext']> | undefined;
          if (context) {
            await this.safeSend(context.thread, `Stream disconnected after ${this.maxRetries} retries.`, threadId, context.sessionId);
          }
        }
        return;
      }
      await new Promise<void>((resolve) => {
        shared.retryWake = resolve;
        const timer = this.setTimeoutFn(resolve, this.getRetryDelay(failures));
        if (shared.cancelled) {
          this.clearTimeoutFn(timer);
          resolve();
        }
      });
      shared.retryWake = undefined;
    }
  }

  private async renameThread(context: ReturnType<StreamHandler['createContext']>, title: string | undefined): Promise<void> {
    const name = title?.trim().slice(0, 100);
    if (!name || /^new session\s*-/iu.test(name) || !context.thread.setName || context.thread.name === name) {
      return;
    }

    try {
      await context.thread.setName(name);
      context.thread.name = name;
    } catch (error) {
      logger.warn('Failed to rename Discord thread', { threadId: context.threadId, sessionId: context.sessionId, error });
    }
  }

  private async handleTextDelta(
    context: ReturnType<StreamHandler['createContext']>,
    payload: GlobalEventLike['payload'],
  ): Promise<void> {
    const delta = getPayloadString(payload, 'delta');
    const field = getPayloadString(payload, 'field');
    if (!delta || (field && field !== 'text')) {
      return;
    }

    const partID = getPayloadString(payload, 'partID') ?? 'default';
    const messageId = getMessageId(payload);
    const role = (messageId ? context.messageRoles.get(messageId) : undefined) ?? getPayloadString(payload, 'messageRole');
    if (role !== 'assistant' && (messageId !== undefined || role !== undefined)) return;
    const inlinePart = getPayloadRecord(payload, 'part');
    const partType = context.partTypes.get(partID)
      ?? (inlinePart && typeof inlinePart.type === 'string'
        ? { type: inlinePart.type, synthetic: inlinePart.synthetic === true }
        : undefined);
    if ((partType?.type !== 'text' && partType?.type !== 'reasoning') || partType.synthetic) {
      return;
    }
    this.beginTyping(context.thread, context.state, context.threadId, context.sessionId);
    const normalizedDelta = normalizeTextDeltaBoundary(context.aggregate, delta);
    context.parts.set(partID, `${context.parts.get(partID) ?? ''}${normalizedDelta}`);
    context.aggregate += normalizedDelta;

    if (!context.tableDetected && detectTable(context.aggregate)) {
      context.tableDetected = true;
      await this.handleTable(context);
    }

    await this.render(context);
  }

  private async handlePartUpdated(
    context: ReturnType<StreamHandler['createContext']>,
    payload: GlobalEventLike['payload'],
  ): Promise<void> {
    const part = getPayloadRecord(payload, 'part');
    if (!part) {
      return;
    }

    const partID = typeof part.id === 'string' ? part.id : getPayloadString(payload, 'partID') ?? 'default';
    if (typeof part.type === 'string') {
      context.partTypes.set(partID, { type: part.type, synthetic: part.synthetic === true });
    }
    if (part.type !== 'tool') return;

    const id = String(part.id ?? part.tool ?? part.name ?? context.runningTools.size);
    const name = String(part.tool ?? part.name ?? id);
    const status = getToolStatus(part);
    if (status === 'running') {
      context.runningTools.set(id, name);
    } else {
      context.runningTools.delete(id);
    }

    if (status === 'completed' || status === 'error') {
      await this.sendToolResult(context, part, status);
    }

    await this.render(context, true);
  }

  private async handleTodoUpdated(
    context: ReturnType<StreamHandler['createContext']>,
    payload: GlobalEventLike['payload'],
  ): Promise<void> {
    const todos = getPayloadArray(payload, 'todos').filter(isRecord);
    if (context.todosPrinted) {
      return;
    }

    context.todosPrinted = true;
    await this.sendMessage(context, formatTodos(todos));
  }

  private async sendToolResult(
    context: ReturnType<StreamHandler['createContext']>,
    part: Record<string, unknown>,
    status: string,
  ): Promise<void> {
    const state = getToolState(part);
    const output = status === 'error' ? getRecordString(state, 'error') : getRecordString(state, 'output');
    const tool = getToolName(part);
    if (tool === 'bash' || tool === 'shell') {
      await this.sendMessage(context, formatToolSummary(part, state, tool, output ?? '', status));
      return;
    }
    if (!output) {
      return;
    }

    const title = getRecordString(state, 'title') ?? String(part.tool ?? part.name ?? 'Tool');
    if (isTodoTool(part)) {
      return;
    }

    const structuredSummary = formatStructuredToolSummary(output);
    if (structuredSummary) {
      await this.sendMessage(context, formatQuote(structuredSummary));
      return;
    }

    if (shouldRenderTitleOnly(part)) {
      await this.sendMessage(context, formatQuote(title));
      return;
    }

    await this.sendMessage(context, formatQuote(formatToolSummary(part, state, title, output, status)));
  }

  private async sendMessage(context: ReturnType<StreamHandler['createContext']>, content: string): Promise<StreamMessage> {
    const message = await context.thread.send(suppressLinkPreviews(content));
    this.requestTypingRepulse(context);
    return message;
  }

  private async render(context: ReturnType<StreamHandler['createContext']>, forceEdit = false): Promise<void> {
    if (!context.aggregate && context.runningTools.size === 0) {
      return;
    }

    const chunks = splitMessage(context.aggregate || '').filter((chunk) => chunk.trim());
    if (chunks.length === 0 && context.runningTools.size === 0) return;
    for (let index = context.sentChunks; index < chunks.length - 1; index += 1) {
      if (context.currentMessage) {
        await context.currentMessage.edit(suppressLinkPreviews(chunks[index] ?? ''));
      } else {
        await this.sendMessage(context, chunks[index] ?? '');
      }
      logger.info('Discord 스트림 조각 전송', { threadId: context.threadId, sessionId: context.sessionId, length: (chunks[index] ?? '').length });
      context.currentMessage = undefined;
      context.sentChunks += 1;
    }

    const content = this.withToolStatus(chunks.at(-1) ?? '', context.runningTools);
    if (!context.currentMessage) {
      context.currentMessage = await this.sendMessage(context, content);
      if (context.aggregate && context.currentMessageId) context.dedupeSet?.add(context.currentMessageId);
      logger.info('Discord 스트림 메시지 전송', { threadId: context.threadId, sessionId: context.sessionId, length: content.length });
      context.lastEditAt = this.now();
      context.lastRenderedContent = content;
      return;
    }

    const currentTime = this.now();
    if (content !== context.lastRenderedContent && (forceEdit || currentTime - context.lastEditAt >= this.editThrottleMs)) {
      try {
        await context.currentMessage.edit(suppressLinkPreviews(content));
      } catch (error) {
        if (context.currentMessageId) context.dedupeSet?.delete(context.currentMessageId);
        throw error;
      }
      logger.info('Discord 스트림 메시지 수정', { threadId: context.threadId, sessionId: context.sessionId, length: content.length });
      context.lastEditAt = currentTime;
      context.lastRenderedContent = content;
    }
  }

  private withToolStatus(content: string, runningTools: Map<string, string>): string {
    const tools = [...runningTools.values()];
    if (tools.length === 0) {
      return content;
    }
    return `${content}\n\n${formatSubtext(`Running: ${tools.join(', ')}`)}`;
  }

  private async switchMessageContext(
    context: ReturnType<StreamHandler['createContext']>,
    payload: GlobalEventLike['payload'],
  ): Promise<void> {
    const messageId = getMessageId(payload);
    if (!messageId || messageId === context.currentMessageId) {
      return;
    }

    if (context.currentMessageId !== undefined) {
      await this.render(context, true);
      context.aggregate = '';
      context.parts.clear();
      context.currentMessage = undefined;
      context.sentChunks = 0;
      context.lastEditAt = Number.NEGATIVE_INFINITY;
      context.lastRenderedContent = undefined;
      context.runningTools.clear();
      context.tableDetected = false;
      context.idleMessageId = undefined;
    }

    context.currentMessageId = messageId;
  }

  private async safeRender(context: ReturnType<StreamHandler['createContext']>): Promise<void> {
    try {
      await this.render(context, true);
    } catch (error) {
      logger.warn('Failed to render stream update during recovery', { threadId: context.threadId, sessionId: context.sessionId, error });
    }
  }

  private async handleTable(context: ReturnType<StreamHandler['createContext']>): Promise<void> {
    try {
      await this.options.tableHandler?.handleTable(context.threadId, context.aggregate);
    } catch (error) {
      logger.warn('Failed to render detected table', { threadId: context.threadId, sessionId: context.sessionId, error });
    }
  }

  private async handleSessionCreated(context: ReturnType<StreamHandler['createContext']>, event: GlobalEventLike): Promise<void> {
    try {
      const autoConnectHandler = this.options.autoConnectHandler;
      const projectPath = event.directory ?? context.projectPath;
      const session = getPayloadValue(event.payload, 'info');
      const createdSessionId = getCreatedSessionId(session);
      if (!autoConnectHandler || !projectPath || !createdSessionId || autoConnectHandler.isSessionAttached(createdSessionId)) {
        return;
      }

      await autoConnectHandler.handleSessionCreated(projectPath, session, context.client);
    } catch (error) {
      logger.warn('Failed to auto-connect created session', { projectPath: event.directory ?? context.projectPath, error });
    }
  }

  private getRetryDelay(failures: number): number {
    return Math.min(this.retryDelayMs * 2 ** Math.max(0, failures - 1), this.maxRetryDelayMs);
  }

}

function toSubscriptionStatus(state: SubscriptionState): StreamSubscriptionStatus {
  return {
    threadId: state.threadId,
    sessionId: state.sessionId,
    projectPath: state.projectPath,
    state: state.runtimeState,
    failures: state.failures,
    lastEventAt: state.lastEventAt,
    lastErrorAt: state.lastErrorAt,
    lastDisconnectAt: state.lastDisconnectAt,
  };
}

function isSessionScopedEvent(type: string): boolean {
  return type === 'message.updated'
    || type === 'message.part.delta'
    || type === 'message.part.updated'
    || type === 'todo.updated'
    || type === 'question.asked'
    || type === 'form.created'
    || type === 'form.replied'
    || type === 'permission.asked'
    || type === 'session.idle'
    || type === 'session.updated'
    || isTerminalExecutionEvent(type)
    || type === 'session.error'
    || type === 'session.status';
}

function isTerminalSessionStatus(status: string | undefined): boolean {
  return status === 'idle' || status === 'error';
}

function getSessionId(payload: GlobalEventLike['payload']): string | undefined {
  const sessionId = getPayloadString(payload, 'sessionID');
  if (sessionId !== undefined) {
    return sessionId;
  }

const request = getPayloadRecord(payload, 'request');
  if (request && typeof request.sessionID === 'string') {
    return request.sessionID;
  }

  const form = getPayloadRecord(payload, 'form');
  if (form && typeof form.sessionID === 'string') {
    return form.sessionID;
  }

  const part = getPayloadRecord(payload, 'part');
  if (part && typeof part.sessionID === 'string') {
    return part.sessionID;
  }

  return undefined;
}

function getMessageId(payload: GlobalEventLike['payload']): string | undefined {
  const messageId = getPayloadString(payload, 'messageID');
  if (messageId !== undefined) return messageId;
  const part = getPayloadRecord(payload, 'part');
  if (part && typeof part.messageID === 'string') return part.messageID;
  const info = getPayloadRecord(payload, 'info');
  return info && typeof info.id === 'string' ? info.id : undefined;
}

function getPayloadRecord(payload: GlobalEventLike['payload'], key: string): Record<string, unknown> | undefined {
  const value = getPayloadValue(payload, key);
  return isRecord(value) ? value : undefined;
}

function getPayloadArray(payload: GlobalEventLike['payload'], key: string): unknown[] {
  const value = getPayloadValue(payload, key);
  return Array.isArray(value) ? value : [];
}

function getPayloadString(payload: GlobalEventLike['payload'], key: string): string | undefined {
  const value = getPayloadValue(payload, key);
  return typeof value === 'string' ? value : undefined;
}

function getPayloadValue(payload: GlobalEventLike['payload'], key: string): unknown {
  const direct = payload[key as keyof GlobalEventLike['payload']];
  if (direct !== undefined) {
    return direct;
  }

  return getPayloadProperties(payload)?.[key];
}

function getPayloadProperties(payload: GlobalEventLike['payload']): Record<string, unknown> | undefined {
  return isRecord(payload.properties) ? payload.properties : undefined;
}

function getCreatedSessionId(session: unknown): string | undefined {
  if (!isRecord(session)) {
    return undefined;
  }

  if (typeof session.id === 'string') {
    return session.id;
  }

  if (typeof session.sessionID === 'string') {
    return session.sessionID;
  }

  return undefined;
}

function getToolStatus(part: Record<string, unknown>): string | undefined {
  const directStatus = part.status;
  if (typeof directStatus === 'string') {
    return directStatus;
  }

  const state = part.state;
  if (isRecord(state) && typeof state.status === 'string') {
    return state.status;
  }

  return undefined;
}

function getToolState(part: Record<string, unknown>): Record<string, unknown> {
  return isRecord(part.state) ? part.state : {};
}

function getRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isTodoTool(part: Record<string, unknown>): boolean {
  const tool = typeof part.tool === 'string' ? part.tool.toLowerCase() : '';
  return tool === 'todowrite' || tool === 'todo';
}

function shouldRenderTitleOnly(part: Record<string, unknown>): boolean {
  const tool = typeof part.tool === 'string' ? part.tool.toLowerCase() : '';
  return tool === 'skill' || tool === 'read';
}

function formatTodos(todos: Record<string, unknown>[]): string {
  const lines = todos.length > 0 ? todos.map(formatTodo) : ['No todos.'];
  return formatQuote(`Todos\n${lines.join('\n')}`);
}

function formatTodo(todo: Record<string, unknown>): string {
  const content = typeof todo.content === 'string' ? todo.content : typeof todo.title === 'string' ? todo.title : 'Untitled todo';
  return `- ${content}`;
}

function formatQuote(content: string): string {
  return content.split('\n').map((line) => `> ${line}`).join('\n');
}

function formatSubtext(content: string): string {
  return content.split('\n').map((line) => `-# ${line}`).join('\n');
}

function normalizeTextDeltaBoundary(aggregate: string, delta: string): string {
  if (!aggregate || /\s$/.test(aggregate) || !/^\*\*[^*\n]+\*\*(?:\n|$)/.test(delta)) {
    return delta;
  }

  return `\n\n${delta}`;
}

function formatStructuredToolSummary(output: string): string | undefined {
  const path = extractTag(output, 'path');
  const type = extractTag(output, 'type')?.toLowerCase();
  if (!path || !type) {
    return undefined;
  }

  if (type === 'directory') {
    const entries = extractTag(output, 'entries') ?? '';
    const entryCount = entries.match(/\((\d+) entries\)/)?.[1];
    const suffix = entryCount ? ` · ${entryCount} entries` : '';
    return `**Read directory:** \`${path}\`${suffix}`;
  }

  if (type === 'file') {
    return `**Read file:** \`${path}\` · content omitted`;
  }

  return `**Tool result:** \`${path}\` · structured output omitted`;
}

function extractTag(output: string, tag: string): string | undefined {
  const match = output.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim();
}

function formatToolSummary(part: Record<string, unknown>, state: Record<string, unknown>, title: string, output: string, status: string): string {
  const tool = getToolName(part);
  const result = status === 'error' ? 'failed' : 'completed';
  if (tool === 'bash' || tool === 'shell') {
    const command = getCommandSummary(state, output, tool)?.replaceAll('@', '@\u200b').replace(/([*_~|`\\])/g, '\\$1');
    return `${status === 'error' ? '⨯' : '┣'} ${tool}${command ? ` _${command}_` : ''}`;
  }
  const patchSummary = formatPatchSummary(output, result);
  if (patchSummary) {
    return patchSummary;
  }

  const searchSummary = formatSearchSummary(tool, output, result);
  if (searchSummary) {
    return searchSummary;
  }

  const command = getCommandSummary(state, output, tool);
  const label = formatToolLabel(tool, title);
  return [`${label} ${result}`, command].filter(Boolean).join(' · ');
}

function getToolName(part: Record<string, unknown>): string {
  const tool = typeof part.tool === 'string' ? part.tool : typeof part.name === 'string' ? part.name : 'tool';
  return tool.toLowerCase();
}

function formatToolLabel(tool: string, title: string): string {
  if (tool === 'glob') {
    return 'Glob';
  }
  if (tool === 'grep') {
    return 'Search';
  }

  return compactTitle(title) || titleCase(tool);
}

function compactTitle(title: string): string {
  return title.replace(/^Task:\s*/i, '').split('\n')[0]?.trim() ?? '';
}

function getCommandSummary(state: Record<string, unknown>, output: string, tool: string): string | undefined {
  const input = isRecord(state.input) ? state.input : undefined;
  const command = typeof input?.command === 'string' ? input.command : undefined;
  if (command) {
    if (tool === 'bash' || tool === 'shell') {
      const firstLine = command.split(/\r?\n/).find((line) => line.trim());
      const short = compactOneLine(firstLine ?? '');
      return short && (short.length > 100 || command.includes('\n') ? `${short.slice(0, 100)}…` : short);
    }
    return compactOneLine(command);
  }

  if (tool !== 'bash') {
    return undefined;
  }

  const firstLine = output.split('\n').find((line) => line.trim());
  return firstLine && firstLine.length <= 120 ? compactOneLine(firstLine) : undefined;
}

function formatPatchSummary(output: string, result: string): string | undefined {
  if (!output.startsWith('Success. Updated the following files:')) {
    return undefined;
  }

  const files = output
    .split('\n')
    .map((line) => line.match(/^[A-Z]\s+(.+)$/)?.[1])
    .filter((file): file is string => Boolean(file))
    .map((file) => file.split('/').at(-1) ?? file);
  const fileText = formatList(files);
  const countText = `${files.length} ${files.length === 1 ? 'file' : 'files'} updated`;
  return [`Patch ${result}`, countText, fileText].filter(Boolean).join(' · ');
}

function formatSearchSummary(tool: string, output: string, result: string): string | undefined {
  if (tool !== 'grep') {
    return undefined;
  }

  const match = output.match(/Found (\d+) matches(?: \(showing first (\d+)\))?/);
  if (!match) {
    return `Search ${result}`;
  }

  const matchCount = match[1];
  const shownCount = match[2];
  const files = extractSearchFiles(output);
  return [
    `Search ${result}`,
    `${matchCount} matches`,
    shownCount ? `${shownCount} shown` : undefined,
    formatList(files),
  ].filter(Boolean).join(' · ');
}

function extractSearchFiles(output: string): string[] {
  const files: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Line ') || !trimmed.endsWith(':')) {
      continue;
    }

    const file = trimmed.slice(0, -1).split('/').at(-1);
    if (file && !files.includes(file)) {
      files.push(file);
    }
  }

  return files;
}

function formatList(values: string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const shown = values.slice(0, MAX_SUMMARY_DETAILS).join(', ');
  const remaining = values.length - MAX_SUMMARY_DETAILS;
  return remaining > 0 ? `${shown} + more` : shown;
}

function compactOneLine(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function titleCase(value: string): string {
  return value.length === 0 ? 'Tool' : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Normalize OpenCode SDK event sources to an async iterable stream.
 * @param source - SDK event source returned by global.event.
 * @returns Async iterable of global events.
 */
export function getEventStream(source: OpenCodeEventSource): AsyncIterable<GlobalEventLike> {
  const stream = isAsyncIterable(source) ? source : source.stream;
  return normalizeEventStream(stream);
}

/** Convert a CLI v2 `form.created` payload into the legacy question request shape. */
function toFormQuestionRequest(payload: GlobalEventLike['payload']): { request: FormQuestionRequest } | undefined {
  const form = getPayloadRecord(payload, 'form');
  if (!form || typeof form.id !== 'string' || typeof form.sessionID !== 'string' || !Array.isArray(form.fields)) {
    return undefined;
  }

  const fields = form.fields.filter(isRecord);
  return {
    request: {
      id: form.id,
      sessionID: form.sessionID,
      keys: fields.map((field) => (typeof field.key === 'string' ? field.key : String(field.key ?? ''))),
      questions: fields.map(toFormQuestionInfo),
    },
  };
}

function toFormQuestionInfo(field: Record<string, unknown>): {
  header: string;
  question: string;
  options: { label: string; description: string; value: string }[];
  multiple: boolean;
  custom: boolean;
} {
  const title = typeof field.title === 'string' ? field.title : String(field.key ?? '??');
  const description = typeof field.description === 'string' ? field.description : title;
  const options = Array.isArray(field.options) ? field.options.filter(isRecord) : [];
  return {
    header: title,
    question: description,
    options: options.map((option) => ({
      label: typeof option.label === 'string' ? option.label : String(option.value ?? ''),
      description: typeof option.description === 'string' ? option.description : '',
      value: typeof option.value === 'string' ? option.value : String(option.label ?? ''),
    })),
    multiple: field.type === 'multiselect',
    custom: field.custom !== false,
  };
}
function getSessionTitle(payload: GlobalEventLike['payload']): string | undefined {
  for (const candidate of [payload.info, payload.properties]) {
    if (!isRecord(candidate)) {
      continue;
    }
    if (typeof candidate.title === 'string') {
      return candidate.title;
    }
    if (isRecord(candidate.info) && typeof candidate.info.title === 'string') {
      return candidate.info.title;
    }
  }
  return undefined;
}

function isTerminalExecutionEvent(type: string): boolean {
  return type === 'session.execution.succeeded'
    || type === 'session.execution.failed'
    || type === 'session.execution.aborted';
}

async function* normalizeEventStream(stream: AsyncIterable<unknown>): AsyncIterable<GlobalEventLike> {
  for await (const raw of stream) {
    if (!isRecord(raw)) {
      continue;
    }

    if (isRecord(raw.payload)) {
      yield raw as unknown as GlobalEventLike;
      continue;
    }

    const data = isRecord(raw.data) ? raw.data : isRecord(raw.properties) ? raw.properties : {};
    const type = typeof raw.type === 'string' ? raw.type : typeof data.type === 'string' ? data.type : '';
    if (type === 'session.next.text.delta' || type === 'session.next.reasoning.delta'
      || type === 'session.text.delta' || type === 'session.reasoning.delta') {
      const reasoning = type.includes('reasoning');
      const rawPartID = reasoning ? data.reasoningID : data.textID;
      const partID = typeof rawPartID === 'string'
        ? rawPartID
        : `${reasoning ? 'reasoning' : 'text'}-${String(data.ordinal ?? 0)}`;
      yield {
        directory: typeof raw.directory === 'string'
          ? raw.directory
          : isRecord(raw.location) && typeof raw.location.directory === 'string' ? raw.location.directory : undefined,
        payload: {
          type: 'message.part.delta',
          sessionID: data.sessionID,
          messageID: data.assistantMessageID,
          partID,
          delta: data.delta,
          field: 'text',
          messageRole: 'assistant',
          part: { id: partID, type: reasoning ? 'reasoning' : 'text' },
        } as GlobalEventLike['payload'],
      };
      continue;
    }

    if (type === 'session.next.step.ended') {
      yield {
        directory: getEventDirectory(raw),
        payload: { ...data, type: 'session.idle' } as GlobalEventLike['payload'],
      };
      continue;
    }

    if (type === 'session.next.step.failed') {
      yield {
        directory: getEventDirectory(raw),
        payload: { ...data, type: 'session.error' } as GlobalEventLike['payload'],
      };
      continue;
    }

    yield {
      directory: getEventDirectory(raw),
      payload: {
        ...data,
        type,
      } as GlobalEventLike['payload'],
    };
  }
}

function getEventDirectory(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.directory === 'string') {
    return raw.directory;
  }
  return isRecord(raw.location) && typeof raw.location.directory === 'string' ? raw.location.directory : undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
