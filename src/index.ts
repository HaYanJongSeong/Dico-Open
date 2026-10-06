import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { SlashCommandBuilder } from 'discord.js';
import { createAgentCommandHandler } from './discord/commands/agent.js';
import { createConnectCommandHandler } from './discord/commands/connect.js';
import { createDiffCommandHandler } from './discord/commands/diff.js';
import { createHelpCommandHandler } from './discord/commands/help.js';
import { createInfoCommandHandler } from './discord/commands/info.js';
import { createInspectCommandHandler } from './discord/commands/inspect.js';
import { createInterruptCommandHandler } from './discord/commands/interrupt.js';
import { getCommandDefinitions as defaultGetCommandDefinitions } from './discord/commands/index.js';
import { createModelCommandHandler } from './discord/commands/model.js';
import { createNewCommandHandler } from './discord/commands/new.js';
import { createRestartCommandHandler } from './discord/commands/restart.js';
import { createStatusCommandHandler } from './discord/commands/status.js';
import { createSyncCommandHandler, type SyncController } from './discord/commands/sync.js';
import {
  createDiscordClient as defaultCreateDiscordClient,
  registerLifecycleHandlers as defaultRegisterLifecycleHandlers,
} from './discord/client.js';
import type { LifecycleController, LifecycleHandlerOptions } from './discord/client.js';
import { deployCommands as defaultDeployCommands } from './discord/deploy.js';
import { handleInteraction } from './discord/handlers/interactionHandler.js';
import type { AutocompleteHandler, CommandHandler } from './discord/handlers/interactionHandler.js';
import { handleMessageCreate } from './discord/handlers/messageHandler.js';
import { suppressLinkPreviews } from './discord/messageOptions.js';
import { CacheManager } from './opencode/cache.js';
import { listSelectableAgentIds } from './opencode/agentIds.js';
import { listModelIds } from './opencode/modelIds.js';
import { PermissionHandler, type PermissionThread } from './opencode/permissionHandler.js';
import { QuestionHandler, type QuestionThread } from './opencode/questionHandler.js';
import { createServerClient, getOpenCodeExecutable, ServerManager } from './opencode/serverManager.js';
import { SessionBridge, type HistoryThreadLike, type OpencodeSessionClient } from './opencode/sessionBridge.js';
import { getEventStream, StreamHandler } from './opencode/streamHandler.js';
import type { AutoConnectDelegate, OpenCodeStreamClient, PermissionEventDelegate, QuestionEventDelegate, StreamThread } from './opencode/streamHandler.js';
import type { ChannelConfig } from './config/types.js';
import type { BotConfig } from './config/types.js';
import type { BotState, ServerState, SessionState } from './state/types.js';
import type { Logger } from './utils/logger.js';
import { createLogger, generateCorrelationId } from './utils/logger.js';
import { BotError, ErrorCode } from './utils/errors.js';

export { ConfigLoader } from './config/loader.js';
export { StateManager } from './state/manager.js';
import { ConfigLoader } from './config/loader.js';
import { StateManager } from './state/manager.js';

// Keep Korean and other Unicode text intact in Windows terminals and redirected logs.
if (process.platform === 'win32') {
  process.stdout.setDefaultEncoding('utf8');
  process.stderr.setDefaultEncoding('utf8');
}

const execFileAsync = promisify(execFile);
const logger = createLogger('startup');

interface ConfigLoaderLike {
  load(): Promise<void> | void;
  getConfig(): BotConfig;
  getChannelConfig?(guildId: string, channelId: string): ChannelConfig | undefined;
  onChange?(callback: (config: BotConfig) => void): void;
  watch?(options?: { onChannelRemoved?: (guildId: string, channelId: string, channelConfig: ChannelConfig) => Promise<void> | void }): void;
  close?(): Promise<void> | void;
}

interface StateManagerLike {
  load(): void;
  getState(): BotState;
  getServer(projectPath: string): ServerState | undefined;
  setServer(projectPath: string, server: ServerState): void;
  removeServer(projectPath: string): void;
  getSession(threadId: string): SessionState | undefined;
  setSession(threadId: string, session: SessionState): void;
  removeSession(threadId: string): void;
  getQueue(threadId: string): unknown[];
  clearQueue(threadId: string): void;
}

interface ServerManagerLike {
  ensureRunning(projectPath: string): Promise<unknown>;
  getClient(projectPath: string): unknown | undefined;
  shutdownAll?(): Promise<void>;
  registerRecovered?(projectPath: string, client: unknown, state: ServerState): void;
}



interface CacheManagerLike {
  refresh(projectPath: string, client: unknown): Promise<void> | void;
  getSessions?(projectPath: string): unknown[];
}

interface StreamHandlerLike {
  subscribe(threadId: string, sessionId: string, client: unknown, dedupeSet?: Set<string>, projectPath?: string): Promise<void> | void;
  startTypingForThread?(threadId: string): void;
  refreshTypingForThread?(threadId: string): void;
  stopTypingForThread?(threadId: string): void;
  unsubscribe?(threadId: string): void;
  getStatus?(threadId: string): { state: string; failures: number; lastEventAt?: number; lastErrorAt?: number; lastDisconnectAt?: number } | undefined;
  renameThreadToTitle?(threadId: string, title: string | undefined): Promise<void> | void;
}

interface DiscordClientLike {
  login(token: string): Promise<unknown> | unknown;
  user?: { id: string } | null;
  channels?: {
    fetch(channelId: string): Promise<unknown> | unknown;
  };
  guilds?: {
    fetch(guildId: string): Promise<unknown> | unknown;
  };
  destroy?: () => void;
  on?: (eventName: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (eventName: string, listener: (...args: unknown[]) => void) => unknown;
}

interface ProcessLike {
  on(eventName: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(eventName: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** Options supplied when constructing the default startup stream handler. */
export interface StartupStreamHandlerOptions {
  getThread(threadId: string): StreamThread | undefined;
  getEventClient?: (client: OpenCodeStreamClient, projectPath?: string) => OpenCodeStreamClient;
  questionHandler: QuestionEventDelegate;
  permissionHandler: PermissionEventDelegate;
  onUserMessage?: (threadId: string) => Promise<void> | void;
  autoConnectHandler?: AutoConnectDelegate;
}

/** Dependency injection options for startup orchestration. */
export interface StartBotOptions {
  configPath?: string;
  statePath?: string;
  configLoader?: ConfigLoaderLike;
  stateManager?: StateManagerLike;
  serverManager?: ServerManagerLike;
  cacheManager?: CacheManagerLike;
  streamHandler?: StreamHandlerLike;
  sessionBridge?: SessionBridge;
  createStreamHandler?: (options: StartupStreamHandlerOptions) => StreamHandlerLike;
  createDiscordClient?: (token: string) => DiscordClientLike;
  deployCommands?: (token: string, guildId: string, commands: SlashCommandBuilder[]) => Promise<void> | void;
  getCommandDefinitions?: () => SlashCommandBuilder[];
  preflight?: () => Promise<void> | void;
  isPidAlive?: (pid: number) => boolean;
  createClient?: (url: string) => unknown;
  healthCheck?: (client: unknown) => Promise<boolean> | boolean;
  killPid?: (pid: number) => void;
  threadExists?: (threadId: string, session: SessionState) => Promise<boolean> | boolean;
  subscribeProjectEvents?: (projectPath: string, client: unknown) => Promise<void> | void;
  autoConnectSession?: (projectPath: string, session: unknown, client: unknown) => Promise<void> | void;
  registerLifecycleHandlers?: typeof defaultRegisterLifecycleHandlers;
  processLike?: ProcessLike;
  setInterval?: LifecycleHandlerOptions['setInterval'];
  clearInterval?: LifecycleHandlerOptions['clearInterval'];
  exit?: LifecycleHandlerOptions['exit'];
  now?: () => number;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** Runtime objects created or used during bot startup. */
export interface StartedBot {
  config: BotConfig;
  stateManager: StateManagerLike;
  serverManager: ServerManagerLike;
  cacheManager: CacheManagerLike;
  discordClient: DiscordClientLike;
  lifecycleController: LifecycleController;
}

/** Dependencies for running the CLI startup entrypoint. */
export interface RunCliOptions {
  start?: () => Promise<unknown>;
  logger?: Pick<Logger, 'error'>;
  processLike?: { exitCode?: number };
}

/**
 * Determine whether this module is the process entrypoint.
 * @param moduleUrl - Current module URL, usually import.meta.url
 * @param argv - Process argv array to inspect
 * @returns True when argv[1] resolves to this module file
 */
export function isDirectEntrypoint(moduleUrl: string, argv: string[]): boolean {
  const entrypoint = argv[1];
  return entrypoint !== undefined && resolve(fileURLToPath(moduleUrl)) === resolve(entrypoint);
}

/**
 * Run the bot from the command-line entrypoint and report startup failures.
 * @param options - Optional injected dependencies for tests
 * @returns Nothing
 */
export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const start = options.start ?? startBot;
  const cliLogger = options.logger ?? logger;
  const processLike = options.processLike ?? process;

  try {
    await start();
  } catch (error) {
    if (error instanceof BotError) {
      cliLogger.error('Bot startup failed', {
        ...error.context,
        code: error.code,
        error: error.message,
      });
    } else {
      cliLogger.error('Bot startup failed', { error: error instanceof Error ? error.stack ?? error.message : error });
    }
    processLike.exitCode = 1;
  }
}

/**
 * Start the Discord bot and recover persisted OpenCode runtime state.
 * @param options - Optional injected dependencies and paths for testable startup.
 * @returns Started runtime dependencies for callers that need lifecycle control.
 */
export async function startBot(options: StartBotOptions = {}): Promise<StartedBot> {
  const startupLogger = options.logger ?? logger;
  await (options.preflight ?? defaultPreflight)();

  const stateManager = options.stateManager ?? new StateManager(options.statePath ?? 'state.json');
  stateManager.load();

  const configLoader = options.configLoader ?? new ConfigLoader(options.configPath ?? 'config.yaml');
  await configLoader.load();
  let config = configLoader.getConfig();
  const autoConnectProjects = getAutoConnectProjects(config);
  const serverManager = options.serverManager ?? new ServerManager({ stateManager, autoConnectProjects });
  const sharedEventClient = process.env.OPENCODE_SHARED_SERVER_URL
    ? createServerClient(process.env.OPENCODE_SHARED_SERVER_URL) : undefined;
  const cacheManager = options.cacheManager ?? new CacheManager({ logger: startupLogger });
  const discordClient = (options.createDiscordClient ?? defaultCreateDiscordClient)(config.discordToken);
  const threadResolver = createDiscordThreadResolver(discordClient, startupLogger);
  const questionHandler = new QuestionHandler({
    getThread: (threadId) => threadResolver.getCached(threadId) as QuestionThread | undefined,
    getChannelConfig: (threadId) => getChannelConfigForThread(stateManager, config, threadId),
  });
  const permissionHandler = new PermissionHandler({
    getThread: (threadId) => threadResolver.getCached(threadId) as PermissionThread | undefined,
    getChannelConfig: (threadId) => getChannelConfigForThread(stateManager, config, threadId),
  });
  const knownAutoConnectSessionIds = new Set(Object.values(stateManager.getState().sessions).map((session) => session.sessionId));
  let wakeSync = (): void => undefined;
  let dedupedAutoConnectSession: (projectPath: string, session: unknown, client: unknown, knownSessionIds: Set<string>) => Promise<void>;
  const autoConnectSession = options.autoConnectSession ?? ((projectPath: string, session: unknown, client: unknown) =>
    defaultAutoConnectSession(projectPath, session, client, {
      config,
      discordClient,
      now: options.now ?? Date.now,
      rememberThread: threadResolver.remember,
      stateManager,
      streamHandler,
      getSessionBridge: () => sessionBridge,
    }));
  const streamHandler = options.streamHandler ?? (options.createStreamHandler ?? createDefaultStreamHandler)({
    getThread: threadResolver.getCached,
    getEventClient: (client) => sharedEventClient ?? client,
    questionHandler: asQuestionEventDelegate(questionHandler),
    permissionHandler: asPermissionEventDelegate(permissionHandler),
    onUserMessage: async (threadId) => {
      const session = stateManager.getSession(threadId);
      if (!session || session.status === 'ended') return;
      try {
        const client = (serverManager.getClient(session.projectPath) ?? recoveredClients.get(session.projectPath)
          ?? await serverManager.ensureRunning(session.projectPath)) as OpencodeSessionClient;
        const thread = (threadResolver.getCached(threadId) ?? await threadResolver.fetch(threadId)) as HistoryThreadLike | undefined;
        if (!thread) return;
        await sessionBridge.replaySessionHistory({
          client, threadId, thread, guildId: session.guildId, channelId: session.channelId,
          projectPath: session.projectPath, sessionId: session.sessionId, agent: session.agent,
          model: session.model, createdBy: session.createdBy, historyLimit: 5,
        });
      } catch (error) {
        startupLogger.warn('사용자 메시지 즉시 동기화 실패', { threadId, sessionId: session.sessionId, error });
        wakeSync();
      }
    },
    autoConnectHandler: {
      isSessionAttached: (sessionId) => knownAutoConnectSessionIds.has(sessionId) || isSessionAttached(stateManager, sessionId),
      handleSessionCreated: async (projectPath, session, client) => {
        await dedupedAutoConnectSession(projectPath, session, client, knownAutoConnectSessionIds);
      },
      recoverMissedSessions: async (projectPath, client) => {
        await reconcileAutoConnectSessions(projectPath, client, dedupedAutoConnectSession, knownAutoConnectSessionIds, startupLogger);
      },
    },
  });
  dedupedAutoConnectSession = dedupeAutoConnectSession(stateManager, autoConnectSession, (path) => getAutoConnectProjects(config).has(path));
   const sessionBridge = options.sessionBridge ?? new SessionBridge({ stateManager, streamSubscriber: asSessionStreamSubscriber(streamHandler), syncImages: process.env.OPENCODE_DISCORD_SYNC_IMAGES === 'true' });

  startupLogger.info('OpenCode 서버 복구 중');
  const recoveredClients = await recoverServers(stateManager, {
    createClient: options.createClient ?? ((url) => {
      const headers = process.env.OPENCODE_SERVER_PASSWORD === undefined
        ? undefined
        : {
            Authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`,
          };
      return createServerClient(url, headers);
    }),
    healthCheck: options.healthCheck ?? defaultHealthCheck,
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    killPid: options.killPid ?? defaultKillPid,
    logger: asLifecycleLogger(startupLogger),
    serverManager,
  });
  startupLogger.info('OpenCode 서버 복구 완료');
  const sessionsSkippedDuringRecovery = options.threadExists === undefined
    ? new Set(Object.entries(stateManager.getState().sessions)
        .filter(([, session]) => session.status !== 'ended')
        .map(([threadId]) => threadId))
    : await recoverSessions(stateManager, serverManager, streamHandler, {
        logger: asLifecycleLogger(startupLogger),
        recoveredClients,
        threadExists: options.threadExists,
        getDedupeSet: (threadId) => sessionBridge.getDedupeSet(threadId),
      });
  recoverQueues(stateManager);
  await startAutoConnectProjects(config, serverManager, recoveredClients, {
    logger: asLifecycleLogger(startupLogger),
    knownSessionIds: knownAutoConnectSessionIds,
    subscribeProjectEvents: options.subscribeProjectEvents === undefined
      ? ((projectPath, client, knownSessionIds) => {
          subscribeToProjectEvents(projectPath, client, stateManager, dedupedAutoConnectSession, startupLogger, knownSessionIds);
        })
      : ((projectPath, client) => options.subscribeProjectEvents?.(projectPath, client)),
    autoConnectSession: dedupedAutoConnectSession,
  }, undefined, false);
  const commands = (options.getCommandDefinitions ?? defaultGetCommandDefinitions)();
  const deployCommands = options.deployCommands ?? defaultDeployCommands;
  for (const server of config.servers) {
    await deployCommands(config.discordToken, server.serverId, commands);
  }

  let runSyncNow = async (): Promise<void> => undefined;
  const syncController: SyncController = {
    getStatus: () => ({ intervalMinutes: 1, paused: false }),
    runNow: async () => await runSyncNow(),
    wake: () => wakeSync(),
  };

  registerDiscordRuntimeHandlers(discordClient, {
    cacheManager,
    configLoader,
    questionHandler,
    serverManager,
    sessionBridge,
    stateManager,
    streamHandler,
    threadResolver,
    logger: startupLogger,
    syncController,
  });
  startupLogger.info('Discord 런타임 핸들러 등록 완료');

  startupLogger.info('Discord 로그인 시작');
  try {
    await discordClient.login(config.discordToken);
  } catch (error) {
    await serverManager.shutdownAll?.();
    discordClient.destroy?.();
    throw error;
  }
  startupLogger.info('Discord 로그인 완료');
    startupLogger.info('Discord 로그인 후 자동 세션 복구 시작', { projectCount: getAutoConnectProjects(config).size });
    for (const projectPath of getAutoConnectProjects(config)) {
      const client = recoveredClients.get(projectPath) ?? serverManager.getClient(projectPath);
      if (client !== undefined) {
        await reconcileAutoConnectSessions(projectPath, client, dedupedAutoConnectSession, knownAutoConnectSessionIds, startupLogger);
      }
    }
    const sessionsToReplay = new Set(sessionsSkippedDuringRecovery);
    for (const [threadId, session] of Object.entries(stateManager.getState().sessions)) {
      if (session.status !== 'ended' && session.lastSyncedMessageId === undefined) {
        sessionsToReplay.add(threadId);
      }
    }
    if (sessionsToReplay.size > 0) {
      await recoverSessions(stateManager, serverManager, streamHandler, {
        logger: asLifecycleLogger(startupLogger),
        recoveredClients,
        threadExists: options.threadExists ?? (async (threadId) => await threadResolver.fetch(threadId) !== undefined),
        threadIds: sessionsSkippedDuringRecovery,
        getDedupeSet: (threadId) => sessionBridge.getDedupeSet(threadId),
      });
      for (const threadId of sessionsToReplay) {
        const session = stateManager.getSession(threadId);
        if (session === undefined) {
          continue;
        }
        const client = (serverManager.getClient(session.projectPath) ?? recoveredClients.get(session.projectPath)) as OpencodeSessionClient | undefined;
         const thread = (threadResolver.getCached(threadId) ?? await threadResolver.fetch(threadId)) as HistoryThreadLike | undefined;
         if (client === undefined || thread === undefined) {
           continue;
         }
        const channelConfig = getChannelConfigForThread(stateManager, config, threadId);
        await warnOnFailure(startupLogger, 'Failed to replay recovered session history', { threadId, sessionId: session.sessionId }, async () => {
          await sessionBridge.replaySessionHistory({
            client,
            threadId,
            guildId: session.guildId,
            channelId: session.channelId,
            projectPath: session.projectPath,
            sessionId: session.sessionId,
            agent: session.agent,
            model: session.model,
            createdBy: session.createdBy,
            historyLimit: channelConfig?.connectHistoryLimit === 0 ? undefined : channelConfig?.connectHistoryLimit ?? 30,
            thread,
          });
        });
      }
    }
    const discoveryClient = recoveredClients.values().next().value;
    const discoveryStartedAt = options.now?.() ?? Date.now();
    const discoverNewSessions = async (): Promise<void> => {
      if (discoveryClient === undefined) {
        return;
      }
      const sessions = await listClientSessions(discoveryClient, undefined);
      for (const session of sessions) {
        const projectPath = getSessionProjectPath(session);
        const sessionCreatedAt = getSessionCreatedAt(session);
        if (projectPath === undefined || sessionCreatedAt < discoveryStartedAt) {
          continue;
        }
        await dedupedAutoConnectSession(projectPath, session, discoveryClient, knownAutoConnectSessionIds);
      }
    };
    // ponytail: CLI v2 never broadcasts session.updated, so titles are polled here instead of via SSE.
    const sessionTitles = new Map<string, string>();
    const refreshSessionTitles = async (): Promise<void> => {
      for (const projectPath of getAutoConnectProjects(config)) {
        const client = recoveredClients.get(projectPath) ?? serverManager.getClient(projectPath);
        if (client === undefined) {
          continue;
        }
        const sessions = await listClientSessions(client, projectPath);
        for (const session of sessions) {
          const sessionId = getSessionId(session);
          if (sessionId === undefined) {
            continue;
          }
          const title = isRecord(session) && typeof session.title === 'string' ? session.title : undefined;
          if (title !== undefined) {
            sessionTitles.set(sessionId, title);
          }
        }
      }
    };
    // ponytail: reuses the auto-connect path so a deleted thread gets a fresh one, no /connect needed.
    const reattachSession = async (session: SessionState, client: unknown): Promise<boolean> => {
      if (client === undefined || !getAutoConnectProjects(config).has(session.projectPath)) {
        return false;
      }
      const title = sessionTitles.get(session.sessionId);
      let attached = false;
      await warnOnFailure(startupLogger, 'Failed to re-attach deleted Discord thread', {
        sessionId: session.sessionId,
        projectPath: session.projectPath,
      }, async () => {
        await autoConnectSession(session.projectPath, { id: session.sessionId, title }, client);
        attached = Object.values(stateManager.getState().sessions)
          .some((entry) => entry.sessionId === session.sessionId && entry.status !== 'ended');
      });
      return attached;
    };
    const deliveryWarnings = new Map<string, number>();
    const deliveryChecks = new Map<string, number>();
    const performSyncNow = async (): Promise<boolean> => {
      let changed = false;
      await warnOnFailure(startupLogger, '주기적 세션 동기화 실패', {}, async () => {
        const beforeSessions = new Set(Object.values(stateManager.getState().sessions).map((session) => session.sessionId));
        await discoverNewSessions();
        const afterDiscovery = new Set(Object.values(stateManager.getState().sessions).map((session) => session.sessionId));
        changed = beforeSessions.size !== afterDiscovery.size;
        await refreshSessionTitles();
        for (const [threadId, session] of Object.entries(stateManager.getState().sessions)) {
          try {
           const client = (serverManager.getClient(session.projectPath) ?? discoveryClient) as OpencodeSessionClient | undefined;
           if (session.status === 'ended') {
             // ponytail: a deleted thread leaves a stale mapping; rebuild it, no /connect needed.
             if (sessionTitles.has(session.sessionId) && await reattachSession(session, client)) {
               stateManager.removeSession(threadId);
               changed = true;
             }
             continue;
           }
            await streamHandler.renameThreadToTitle?.(threadId, sessionTitles.get(session.sessionId));
          const thread = (threadResolver.getCached(threadId) ?? await threadResolver.fetch(threadId)) as HistoryThreadLike | undefined;
           if (thread === undefined) {
             // ponytail: a deleted thread is not a dead session; re-attach before giving up.
             if (await reattachSession(session, client)) {
               stateManager.removeSession(threadId);
               changed = true;
               continue;
             }
             stateManager.setSession(threadId, { ...session, status: 'ended' });
             changed = true;
             continue;
           }
           if (client === undefined) {
             continue;
           }
          const previousMessageId = stateManager.getSession(threadId)?.lastSyncedMessageId;
           const replay = await sessionBridge.replaySessionHistory({
            client,
            threadId,
            guildId: session.guildId,
            channelId: session.channelId,
            projectPath: session.projectPath,
            sessionId: session.sessionId,
            agent: session.agent,
            model: session.model,
            createdBy: session.createdBy,
            historyLimit: 5,
             thread,
           });
             const now = options.now?.() ?? Date.now();
             if (now - (deliveryWarnings.get(threadId) ?? 0) >= 600_000
               && replay.latestAssistantAt !== undefined && now - replay.latestAssistantAt >= 120_000
               && now - (deliveryChecks.get(threadId) ?? 0) >= 60_000 && discordClient.user?.id) {
               deliveryChecks.set(threadId, now);
               // ponytail: diagnostics run outside the serial history scan; check receipts at most once per minute.
               void warnOnFailure(startupLogger, 'Discord 전송 확인 실패', { threadId }, async () => {
                 if (await isDiscordSyncStalled(thread, discordClient.user?.id, replay.latestAssistantAt, now)) {
                   deliveryWarnings.set(threadId, now);
                   startupLogger.warn('Discord 동기화 지연 감지', { threadId, sessionId: session.sessionId, latestAssistantAt: replay.latestAssistantAt });
                   await warnOnFailure(startupLogger, 'Discord 동기화 지연 알림 실패', { threadId }, async () => {
                     await thread.send(suppressLinkPreviews(SYNC_STALL_NOTICE));
                   });
                 }
               });
             }
           changed ||= stateManager.getSession(threadId)?.lastSyncedMessageId !== previousMessageId;
           } catch (error) {
             if (error instanceof BotError && error.code === ErrorCode.SESSION_NOT_FOUND && error.context.status === 404) {
               const current = stateManager.getSession(threadId);
               if (current?.sessionId === session.sessionId && current.status !== 'ended') {
                 stateManager.setSession(threadId, { ...current, status: 'ended' });
                 streamHandler.unsubscribe?.(threadId);
                 changed = true;
                 startupLogger.warn('OpenCode에서 삭제된 세션의 동기화 종료', { threadId, sessionId: session.sessionId });
                 await warnOnFailure(startupLogger, '삭제된 세션 안내 실패', { threadId }, async () => {
                   const thread = (threadResolver.getCached(threadId) ?? await threadResolver.fetch(threadId)) as HistoryThreadLike | undefined;
                   await thread?.send(suppressLinkPreviews('OpenCode 세션을 찾을 수 없어 동기화를 종료했습니다. `/new`로 새 세션을 시작하세요.'));
                 });
               }
               continue;
             }
             startupLogger.warn('Failed to synchronize session', { threadId, sessionId: session.sessionId, error });
          }
        }
      });
      return changed;
    };
    let syncInFlight: Promise<boolean> | undefined;
    const syncNow = (): Promise<boolean> => {
      if (syncInFlight !== undefined) {
        return syncInFlight;
      }
      syncInFlight = performSyncNow().finally(() => {
        syncInFlight = undefined;
      });
      return syncInFlight;
    };
    runSyncNow = async () => { await syncNow(); };
    const delays = [1, 5, 30, 60, 300, 600];
    let delayIndex = 0;
    let unchangedChecks = 0;
    let historyPoller: ReturnType<typeof setTimeout> | undefined;
    const scheduleSync = (): void => {
      if (historyPoller !== undefined) clearTimeout(historyPoller);
      const delaySeconds = Math.min(delays[delayIndex] ?? 600, 60);
      historyPoller = setTimeout(() => {
        void syncNow().then((changed) => {
          if (changed) {
            delayIndex = 0;
            unchangedChecks = 0;
          } else if (delayIndex === 0 && unchangedChecks < 9) {
            unchangedChecks += 1;
          } else {
            delayIndex = Math.min(delayIndex + 1, delays.length - 1);
            unchangedChecks = 0;
          }
          scheduleSync();
        });
      }, delaySeconds * 1000);
      historyPoller.unref?.();
    };
    wakeSync = (): void => {
      delayIndex = 0;
      unchangedChecks = 0;
      if (historyPoller !== undefined) clearTimeout(historyPoller);
      void syncNow().then(() => scheduleSync());
    };
    scheduleSync();
    startupLogger.info('세션 동기화 활성화', { interval: '변경 시 1초, 무변경 시 점진적 증가', maxIntervalMinutes: 1, historyRecovery: '최근 메시지 조회' });

  configLoader.onChange?.((nextConfig) => {
    config = nextConfig;
    for (const server of nextConfig.servers) {
      void warnOnFailure(startupLogger, 'Failed to deploy Discord commands after config reload', { guildId: server.serverId }, async () => {
        await deployCommands(nextConfig.discordToken, server.serverId, commands);
      });
    }
  });

  const registerLifecycleHandlers = options.registerLifecycleHandlers ?? defaultRegisterLifecycleHandlers;
  const lifecycleClient = options.registerLifecycleHandlers === undefined
    ? asLifecycleClient(discordClient)
    : discordClient as Parameters<typeof defaultRegisterLifecycleHandlers>[0];
  const lifecycleServerManager = options.registerLifecycleHandlers === undefined
    ? {
      shutdownAll: async () => {
        await serverManager.shutdownAll?.();
        await shutdownRecoveredServers(recoveredClients, stateManager, options.killPid ?? defaultKillPid, startupLogger);
      },
    }
    : serverManager as Parameters<typeof defaultRegisterLifecycleHandlers>[1]['serverManager'];
  const lifecycleController = registerLifecycleHandlers(lifecycleClient, {
    stateManager,
    serverManager: lifecycleServerManager,
    abortSession: async (threadId, session) => {
      await abortSessionFromServerManager(serverManager, recoveredClients, threadId, session, startupLogger);
    },
    processLike: options.processLike,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    exit: options.exit,
    now: options.now,
    logger: asLifecycleLogger(startupLogger),
  });

  const startedLifecycleController = configLoader.close === undefined
    ? lifecycleController
    : wrapLifecycleController(lifecycleController, async () => {
      await configLoader.close?.();
    });

  configLoader.watch?.({
    onChannelRemoved: async (guildId, channelId) => {
      await cleanupRemovedChannelSessions(guildId, channelId, stateManager, serverManager, recoveredClients, threadResolver, startupLogger);
    },
  });

  return { config, stateManager, serverManager, cacheManager, discordClient, lifecycleController: startedLifecycleController };
}

interface RuntimeHandlerDependencies {
  cacheManager: CacheManagerLike;
  configLoader: ConfigLoaderLike;
  questionHandler: QuestionHandler;
  serverManager: ServerManagerLike;
  sessionBridge: SessionBridge;
  stateManager: StateManagerLike;
  streamHandler: StreamHandlerLike;
  threadResolver: ThreadResolver;
  logger: Pick<Logger, 'error'>;
  syncController: SyncController;
}

const SYNC_STALL_NOTICE = 'OpenCode와 Discord의 동기화가 지연되고 있습니다. 서버 연결과 봇 로그를 확인하세요.';

/** Compare recent OpenCode output to the last actual Discord bot delivery. */
export async function isDiscordSyncStalled(thread: unknown, botUserId: string | undefined, latestAssistantAt: number | undefined, now = Date.now()): Promise<boolean> {
  if (!botUserId || !latestAssistantAt || now - latestAssistantAt < 120_000
    || !isRecord(thread) || !isRecord(thread.messages) || typeof thread.messages.fetch !== 'function') return false;
  const recent: unknown = await thread.messages.fetch({ limit: 25 });
  if (!isRecord(recent) || typeof recent.values !== 'function') return false;
  const messages = [...recent.values() as Iterable<unknown>];
  // ponytail: only 25 recent Discord messages are checked; track per-message delivery receipts if active threads exceed this window.
  const deliveredAt = Math.max(0, ...messages.filter((message) => isRecord(message) && isRecord(message.author)
    && message.author.id === botUserId && !(typeof message.content === 'string'
      && (message.content.startsWith(SYNC_STALL_NOTICE) || message.content.startsWith('**User:**') || message.content.startsWith('**나:**'))))
    .map((message) => isRecord(message) && typeof message.editedTimestamp === 'number' ? message.editedTimestamp
      : isRecord(message) && typeof message.createdTimestamp === 'number' ? message.createdTimestamp : 0));
  return latestAssistantAt > deliveredAt;
}

function registerDiscordRuntimeHandlers(client: DiscordClientLike, dependencies: RuntimeHandlerDependencies): void {
  const commandHandlers = createRuntimeCommandHandlers(dependencies);
  const autocompleteHandler = createAutocompleteHandler(dependencies);

  client.on?.('interactionCreate', (interaction) => {
    logger.info('Raw interactionCreate received', getRawInteractionLogContext(interaction));
    void handleInteraction(interaction as Parameters<typeof handleInteraction>[0], {
      autocompleteHandler,
      commandHandlers,
      configLoader: asInteractionConfigLoader(dependencies.configLoader),
    });
  });

  client.on?.('messageCreate', (message) => {
    rememberMessageThread(message, dependencies.threadResolver);
    logger.info('Discord 메시지 수신', {
      threadId: getMessageThreadId(message),
      authorId: isRecord(message) && isRecord(message.author) && typeof message.author.id === 'string' ? message.author.id : undefined,
      isBot: isRecord(message) && isRecord(message.author) ? message.author.bot === true : undefined,
      contentLength: isRecord(message) && typeof message.content === 'string' ? message.content.length : undefined,
    });
    void handleMessageCreate(message as Parameters<typeof handleMessageCreate>[0], {
      getChannelConfig: (session) => dependencies.configLoader.getConfig().servers
        .find((server) => server.serverId === session.guildId)?.channels
        .find((channel) => channel.channelId === session.channelId),
      questionHandler: dependencies.questionHandler,
      sessionBridge: {
        isBusy: () => false,
        sendPrompt: async (threadId, content, options) => {
          logger.info('OpenCode 프롬프트 전달 시작', { threadId, contentLength: content.length });
          const clientForSession = await dependencies.serverManager.ensureRunning(options.session.projectPath) as Parameters<SessionBridge['sendPrompt']>[1]['client'];
          await dependencies.sessionBridge.sendPrompt(threadId, {
            client: clientForSession,
            content,
            files: options.contextFiles.map((file) => ({
              url: file.url,
              mime: file.mime ?? 'application/octet-stream',
              filename: file.filename,
            })),
          });
          dependencies.syncController.wake();
          logger.info('OpenCode 프롬프트 전달 완료', { threadId });
        },
      },
      stateManager: dependencies.stateManager as StateManager,
    }).catch((err: unknown) => {
      const threadId = getMessageThreadId(message);
      const correlationId = generateCorrelationId(threadId ?? 'message');
      dependencies.logger.error('Failed to handle Discord thread message', { threadId, correlationId, err });
      void notifyMessageThreadFailure(message, correlationId);
    });
  });
}

async function notifyMessageThreadFailure(message: unknown, correlationId: string): Promise<void> {
  if (!isRecord(message) || !isRecord(message.channel) || typeof message.channel.send !== 'function') {
    return;
  }

  await message.channel.send(suppressLinkPreviews(`OpenCode에 메시지를 보내지 못했습니다. *(참조: ${correlationId})*`));
}

function getMessageThreadId(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  if (isRecord(message.channel) && typeof message.channel.id === 'string') {
    return message.channel.id;
  }

  return typeof message.channelId === 'string' ? message.channelId : undefined;
}

function getRawInteractionLogContext(interaction: unknown): Record<string, unknown> {
  if (!isRecord(interaction)) {
    return { interactionType: typeof interaction };
  }

  return {
    id: typeof interaction.id === 'string' ? interaction.id : undefined,
    commandName: typeof interaction.commandName === 'string' ? interaction.commandName : undefined,
    channelId: typeof interaction.channelId === 'string' ? interaction.channelId : undefined,
    guildId: typeof interaction.guildId === 'string' ? interaction.guildId : undefined,
    type: interaction.type,
    isChatInputCommand: typeof interaction.isChatInputCommand === 'function' ? interaction.isChatInputCommand() : undefined,
    isAutocomplete: typeof interaction.isAutocomplete === 'function' ? interaction.isAutocomplete() : undefined,
  };
}

function rememberMessageThread(message: unknown, threadResolver: ThreadResolver): void {
  if (!isRecord(message) || !isRecord(message.channel) || typeof message.channel.isThread !== 'function' || message.channel.isThread() !== true) {
    return;
  }

  const threadId = typeof message.channel.id === 'string'
    ? message.channel.id
    : typeof message.channelId === 'string'
      ? message.channelId
      : undefined;
  if (threadId !== undefined) {
    threadResolver.remember(threadId, message.channel);
  }
}

function asQuestionEventDelegate(questionHandler: QuestionHandler): QuestionEventDelegate {
  return {
    handleQuestionEvent: async (threadId, event, client) => {
      await questionHandler.handleQuestionEvent(threadId, event, client as never);
    },
    handleQuestionSettled: (threadId) => {
      questionHandler.clearPending(threadId);
    },
  };
}

function asPermissionEventDelegate(permissionHandler: PermissionHandler): PermissionEventDelegate {
  return {
    handlePermissionEvent: async (threadId, event, client) => {
      await permissionHandler.handlePermissionEvent(threadId, event, client as never);
    },
  };
}

function asInteractionConfigLoader(configLoader: ConfigLoaderLike): ConfigLoader {
  return {
    getChannelConfig: (guildId: string, channelId: string) => {
      if (typeof configLoader.getChannelConfig === 'function') {
        return configLoader.getChannelConfig(guildId, channelId);
      }

      const server = configLoader.getConfig().servers.find((item) => item.serverId === guildId);
      return server?.channels.find((channel) => channel.channelId === channelId);
    },
  } as ConfigLoader;
}

function getChannelConfigForThread(stateManager: StateManagerLike, config: BotConfig, threadId: string): ChannelConfig | undefined {
  const session = stateManager.getSession(threadId);
  if (session === undefined) {
    return undefined;
  }

  const server = config.servers.find((item) => item.serverId === session.guildId);
  return server?.channels.find((channel) => channel.channelId === session.channelId);
}

function createRuntimeCommandHandlers(dependencies: RuntimeHandlerDependencies): Map<string, CommandHandler> {
  const stateManager = dependencies.stateManager as StateManager;
  const serverManager = dependencies.serverManager as never;
  const cacheManager = dependencies.cacheManager as CacheManager;
  const streamHandler = dependencies.streamHandler as never;
  const streamStatusProvider = dependencies.streamHandler.getStatus
    ? { getStatus: dependencies.streamHandler.getStatus.bind(dependencies.streamHandler) }
    : undefined;
  return new Map<string, CommandHandler>([
    ['new', createNewCommandHandler({
      serverManager: dependencies.serverManager,
      sessionBridge: dependencies.sessionBridge,
      rememberThread: dependencies.threadResolver.remember,
    })],
    ['connect', createConnectCommandHandler({ stateManager, serverManager: dependencies.serverManager, sessionBridge: dependencies.sessionBridge })],
    ['agent', createAgentCommandHandler({ stateManager, serverManager: dependencies.serverManager, cacheManager })],
    ['model', createModelCommandHandler({ stateManager, serverManager: dependencies.serverManager, cacheManager })],
    ['interrupt', createInterruptCommandHandler({ stateManager, serverManager: dependencies.serverManager, sessionBridge: dependencies.sessionBridge })],
    ['info', createInfoCommandHandler({ stateManager, serverManager: dependencies.serverManager, cacheManager, streamStatusProvider })],
    ['inspect', createInspectCommandHandler({ stateManager, serverManager: dependencies.serverManager })],
    ['status', createStatusCommandHandler({ stateManager, streamStatusProvider })],
    ['sync', createSyncCommandHandler(dependencies.syncController)],
    ['help', createHelpCommandHandler()],
    ['restart', createRestartCommandHandler({
      cacheManager: cacheManager as never,
      getThread: dependencies.threadResolver.getCached,
      serverManager,
      stateManager,
      streamHandler,
      getDedupeSet: (threadId) => dependencies.sessionBridge.getDedupeSet(threadId),
    })],
    ['diff', createDiffCommandHandler({ stateManager, serverManager: dependencies.serverManager })],
  ]);
}

function createAutocompleteHandler(dependencies: RuntimeHandlerDependencies): AutocompleteHandler {
  return async (interaction, context) => {
    const channelConfig = context.channelConfig;
    if (channelConfig === undefined) {
      return [];
    }

    const focused = interaction.options.getFocused(true);
    const value = String(focused.value ?? '');
    const cacheManager = dependencies.cacheManager as CacheManager;
    if (focused.name === 'agent') {
      const client = dependencies.serverManager.getClient(channelConfig.projectPath);
      if (client !== undefined) {
        try {
          await dependencies.cacheManager.refresh(channelConfig.projectPath, client);
        } catch {
          // Autocomplete should degrade to the last cached agents if refresh fails.
        }
      }
      return listSelectableAgentIds(cacheManager.getAgents(channelConfig.projectPath))
        .filter((name) => !channelConfig.allowedAgents?.length || channelConfig.allowedAgents.includes(name))
        .filter((name) => name.toLowerCase().includes(value.toLowerCase()))
        .slice(0, 25)
        .map((name) => ({ name, value: name }));
    }

    if (focused.name === 'model') {
      const client = dependencies.serverManager.getClient(channelConfig.projectPath);
      if (client !== undefined) {
        try {
          await dependencies.cacheManager.refresh(channelConfig.projectPath, client);
        } catch {
          // Autocomplete should degrade to the last cached models if refresh fails.
        }
      }
      return listModelIds(cacheManager.getModels(channelConfig.projectPath))
        .filter((model) => model.toLowerCase().includes(value.toLowerCase()))
        .slice(0, 25)
        .map((model) => ({ name: model, value: model }));
    }

    if (focused.name === 'session') {
      const client = dependencies.serverManager.getClient(channelConfig.projectPath);
      if (client !== undefined) {
        try {
          await dependencies.cacheManager.refresh(channelConfig.projectPath, client);
        } catch {
          // Autocomplete should degrade to the last cached sessions if refresh fails.
        }
      }
      const attachedSessionIds = new Set(
        Object.values(dependencies.stateManager.getState().sessions)
          .filter((session) => session.status !== 'ended')
          .map((session) => session.sessionId),
      );
      return cacheManager.getSessions(channelConfig.projectPath)
        .map((session) => {
          const sessionId = getSessionId(session);
          return { name: sessionId ? getSessionTitle(session, sessionId) : undefined, value: sessionId };
        })
        .filter((choice): choice is { name: string; value: string } => Boolean(choice.name && choice.value))
        .filter((choice) => !attachedSessionIds.has(choice.value))
        .filter((choice) => choice.name.toLowerCase().includes(value.toLowerCase()))
        .slice(0, 25);
    }

    return [];
  };
}

function asSessionStreamSubscriber(streamHandler: StreamHandlerLike): ConstructorParameters<typeof SessionBridge>[0]['streamSubscriber'] {
  return {
    subscribe: async (threadId, sessionId, client, dedupeSet) => {
      await streamHandler.subscribe(threadId, sessionId, client, dedupeSet);
    },
    startTypingForThread: (threadId) => streamHandler.startTypingForThread?.(threadId),
    refreshTypingForThread: (threadId) => streamHandler.refreshTypingForThread?.(threadId),
    stopTypingForThread: (threadId) => streamHandler.stopTypingForThread?.(threadId),
  };
}

interface ServerRecoveryDependencies {
  createClient(url: string): unknown;
  healthCheck(client: unknown): Promise<boolean> | boolean;
  isPidAlive(pid: number): boolean;
  killPid(pid: number): void;
  logger: Pick<Logger, 'warn'>;
  serverManager?: Pick<ServerManagerLike, 'ensureRunning' | 'registerRecovered'>;
}

interface SessionRecoveryDependencies {
  logger: Pick<Logger, 'warn'>;
  recoveredClients: Map<string, unknown>;
  threadExists(threadId: string, session: SessionState): Promise<boolean> | boolean;
  threadIds?: Set<string>;
  getDedupeSet?(threadId: string): Set<string>;
}

interface AutoConnectDependencies {
  logger: Pick<Logger, 'warn'>;
  knownSessionIds: Set<string>;
  subscribeProjectEvents(projectPath: string, client: unknown, knownSessionIds: Set<string>): Promise<void> | void;
  autoConnectSession(projectPath: string, session: unknown, client: unknown, knownSessionIds: Set<string>): Promise<void> | void;
}

async function recoverServers(
  stateManager: StateManagerLike,
  dependencies: ServerRecoveryDependencies,
): Promise<Map<string, unknown>> {
  const recoveredClients = new Map<string, unknown>();

  for (const [projectPath, server] of Object.entries(stateManager.getState().servers)) {
    if (server.status !== 'running') {
      continue;
    }

    const sharedUrl = process.env.OPENCODE_SHARED_SERVER_URL;
    const sharedProject = process.env.OPENCODE_SHARED_SERVER_PROJECT;
    const isShared = sharedUrl !== undefined && sharedProject === projectPath;
    if (isShared) {
      // ponytail: the shared server outlives this bot, so re-attach it instead of marking it stopped,
      // which would drop the event stream of every thread bound to that project after a restart.
      await warnOnFailure(dependencies.logger, 'Failed to re-attach shared OpenCode server', { projectPath }, async () => {
        const client = await dependencies.serverManager?.ensureRunning(projectPath);
        if (client !== undefined) {
          recoveredClients.set(projectPath, client);
        }
      });
      continue;
    }

    if (!isShared && (server.pid <= 0 || !dependencies.isPidAlive(server.pid))) {
      stateManager.setServer(projectPath, { ...server, status: 'stopped' });
      continue;
    }

    const client = dependencies.createClient(isShared ? sharedUrl as string : server.url);
    if (await dependencies.healthCheck(client)) {
      recoveredClients.set(projectPath, client);
      dependencies.serverManager?.registerRecovered?.(projectPath, client, server);
      continue;
    }

    await warnOnFailure(dependencies.logger, 'Failed to kill unhealthy OpenCode process', { projectPath, pid: server.pid }, async () => {
      dependencies.killPid(server.pid);
    });
    stateManager.setServer(projectPath, { ...server, status: 'stopped' });
  }

  return recoveredClients;
}

async function recoverSessions(
  stateManager: StateManagerLike,
  serverManager: ServerManagerLike,
  streamHandler: StreamHandlerLike,
  dependencies: SessionRecoveryDependencies,
): Promise<Set<string>> {
  const skipped = new Set<string>();

  for (const [threadId, session] of Object.entries(stateManager.getState().sessions)) {
    if (dependencies.threadIds !== undefined && !dependencies.threadIds.has(threadId)) {
      continue;
    }

    if (session.status === 'ended') {
      continue;
    }

    const server = stateManager.getServer(session.projectPath);
    if (server?.status !== 'running') {
      skipped.add(threadId);
      continue;
    }

    const exists = await dependencies.threadExists(threadId, session);
    if (!exists) {
      stateManager.setSession(threadId, { ...session, status: 'ended' });
      continue;
    }

    const client = serverManager.getClient(session.projectPath) ?? dependencies.recoveredClients.get(session.projectPath);
    if (client === undefined) {
      skipped.add(threadId);
      continue;
    }

    await warnOnFailure(dependencies.logger, 'Failed to resubscribe recovered session stream', {
      threadId,
      sessionId: session.sessionId,
      projectPath: session.projectPath,
    }, async () => {
      await streamHandler.subscribe(threadId, session.sessionId, client, dependencies.getDedupeSet?.(threadId), session.projectPath);
    });
  }

  return skipped;
}

function recoverQueues(stateManager: StateManagerLike): void {
  for (const [threadId, entries] of Object.entries(stateManager.getState().queues)) {
    if (entries.length > 0 && stateManager.getSession(threadId)?.status === 'ended') {
      stateManager.clearQueue(threadId);
    }
  }
}

async function startAutoConnectProjects(
  config: BotConfig,
  serverManager: ServerManagerLike,
  recoveredClients: Map<string, unknown>,
  dependencies: AutoConnectDependencies,
  minimumActivityAt?: number,
  reconcileSessions = true,
): Promise<void> {
  for (const projectPath of getAutoConnectProjects(config)) {
    const client = recoveredClients.get(projectPath) ?? await serverManager.ensureRunning(projectPath);
    recoveredClients.set(projectPath, client);
    await warnOnFailure(dependencies.logger, 'Failed to subscribe to auto-connect project events', { projectPath }, async () => {
      await dependencies.subscribeProjectEvents(projectPath, client, dependencies.knownSessionIds);
    });
    if (reconcileSessions) await warnOnFailure(dependencies.logger, 'Failed to reconcile auto-connect sessions', { projectPath }, async () => {
      const sessions = await listClientSessions(client, projectPath);
      for (const session of sessions) {
        const activityAt = getSessionUpdatedAt(session);
        if (minimumActivityAt !== undefined && activityAt !== 0 && activityAt < minimumActivityAt) {
          continue;
        }
        const sessionId = getSessionId(session);
        if (sessionId === undefined || dependencies.knownSessionIds.has(sessionId)) {
          continue;
        }

        await dependencies.autoConnectSession(projectPath, session, client, dependencies.knownSessionIds);
      }
    });
  }
}

function dedupeAutoConnectSession(
  stateManager: StateManagerLike,
  autoConnectSession: (projectPath: string, session: unknown, client: unknown) => Promise<void> | void,
  isConfiguredProject: (projectPath: string) => boolean,
): (projectPath: string, session: unknown, client: unknown, knownSessionIds: Set<string>) => Promise<void> {
  return async (projectPath, session, client, knownSessionIds) => {
    const sessionId = getSessionId(session);
    if (!isConfiguredProject(projectPath) || (getSessionProjectPath(session) !== undefined && getSessionProjectPath(session) !== projectPath)
      || sessionId === undefined || (isRecord(session) && typeof session.parentID === 'string' && session.parentID !== '')
      || knownSessionIds.has(sessionId) || isSessionAttached(stateManager, sessionId)) {
      return;
    }

    knownSessionIds.add(sessionId);
    try {
      await autoConnectSession(projectPath, session, client);
    } finally {
      if (!isSessionAttached(stateManager, sessionId)) {
        knownSessionIds.delete(sessionId);
      }
    }
  };
}

function subscribeToProjectEvents(
  projectPath: string,
  client: unknown,
  stateManager: StateManagerLike,
  autoConnectSession: (projectPath: string, session: unknown, client: unknown, knownSessionIds: Set<string>) => Promise<void> | void,
  subscriptionLogger: Pick<Logger, 'warn'>,
  knownSessionIds = new Set(Object.values(stateManager.getState().sessions).map((session) => session.sessionId)),
  minimumActivityAt?: number,
): void {
  if (!isRecord(client) || (!isRecord(client.v2Root) && !isRecord(client.event) && (!isRecord(client.global) || typeof client.global.event !== 'function'))) {
    return;
  }

  void (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const eventApi = client.event;
        const v2Root = client.v2Root;
        const globalApi = client.global;
        if ((!isRecord(v2Root) || !isRecord(v2Root.event) || typeof v2Root.event.subscribe !== 'function') && (!isRecord(eventApi) || typeof eventApi.subscribe !== 'function') && (!isRecord(globalApi) || typeof globalApi.event !== 'function')) {
          return;
        }

        const source = isRecord(v2Root) && isRecord(v2Root.event) && typeof v2Root.event.subscribe === 'function'
          ? v2Root.event.subscribe({ directory: projectPath })
          : isRecord(eventApi) && typeof eventApi.subscribe === 'function'
            ? eventApi.subscribe()
            : (globalApi as { event: () => unknown }).event();
        const events = getEventStream(await source as never);

        for await (const event of events) {
          const session = getCreatedSession(event);
          const sessionId = getSessionId(session);
          if (session === undefined || sessionId === undefined || knownSessionIds.has(sessionId)) {
            continue;
          }

          await autoConnectSession(projectPath, session, client, knownSessionIds);
        }
        await reconcileAutoConnectSessions(projectPath, client, autoConnectSession, knownSessionIds, subscriptionLogger, minimumActivityAt);
        return;
      } catch (error) {
        subscriptionLogger.warn('Auto-connect project event subscription failed', { projectPath, error });
        await reconcileAutoConnectSessions(projectPath, client, autoConnectSession, knownSessionIds, subscriptionLogger, minimumActivityAt);
      }
    }
  })();
}

async function reconcileAutoConnectSessions(
  projectPath: string,
  client: unknown,
  autoConnectSession: (projectPath: string, session: unknown, client: unknown, knownSessionIds: Set<string>) => Promise<void> | void,
  knownSessionIds: Set<string>,
  reconciliationLogger: Pick<Logger, 'warn'>,
  minimumActivityAt?: number,
): Promise<void> {
  await warnOnFailure(reconciliationLogger, 'Failed to reconcile auto-connect sessions after event disconnect', { projectPath }, async () => {
    const sessions = await listClientSessions(client, projectPath);
      logger.info('자동 세션 복구 조회 완료', { projectPath, sessionCount: sessions.length });
    for (const session of sessions) {
      const activityAt = getSessionUpdatedAt(session);
      if (minimumActivityAt !== undefined && activityAt !== 0 && activityAt < minimumActivityAt) {
        continue;
      }
      const sessionId = getSessionId(session);
      if (sessionId === undefined || knownSessionIds.has(sessionId)) {
        continue;
      }

      await autoConnectSession(projectPath, session, client, knownSessionIds);
    }
  });
}

function isSessionAttached(stateManager: StateManagerLike, sessionId: string): boolean {
  return Object.values(stateManager.getState().sessions).some((session) => session.sessionId === sessionId && session.status !== 'ended');
}

function getCreatedSession(event: unknown): unknown {
  if (!isRecord(event) || !isRecord(event.payload) || event.payload.type !== 'session.created') {
    return undefined;
  }

  return event.payload.info;
}

interface DefaultAutoConnectDependencies {
  config: BotConfig;
  discordClient: DiscordClientLike;
  now: () => number;
  rememberThread?: (threadId: string, thread: unknown) => void;
  stateManager: StateManagerLike;
  streamHandler: StreamHandlerLike;
  // ponytail: resolved lazily because SessionBridge is built after this callback is captured.
  getSessionBridge?: () => Pick<SessionBridge, 'getDedupeSet' | 'replaySessionHistory'> | undefined;
}

async function defaultAutoConnectSession(
  projectPath: string,
  session: unknown,
  client: unknown,
  dependencies: DefaultAutoConnectDependencies,
): Promise<void> {
  const sessionId = getSessionId(session);
  logger.info('자동 세션 연결 시작', { projectPath, sessionId });
  const channel = await ensureProjectChannel(projectPath, dependencies);
  if (sessionId === undefined || channel === undefined || dependencies.discordClient.channels === undefined) {
    return;
  }

  const parentChannel = await dependencies.discordClient.channels.fetch(channel.channel.channelId);
  if (!hasThreadCreate(parentChannel)) {
    return;
  }

  const thread = await parentChannel.threads.create({ name: getSessionTitle(session, sessionId).slice(0, 100) });
  if (!isRecord(thread) || typeof thread.id !== 'string') {
    return;
  }
  const threadId = thread.id;
  dependencies.rememberThread?.(threadId, thread);

  const timestamp = dependencies.now();
  dependencies.stateManager.setSession(threadId, {
    sessionId,
    guildId: channel.guildId,
    channelId: channel.channel.channelId,
    projectPath,
    agent: channel.channel.defaultAgent ?? 'build',
    model: null,
    createdBy: 'auto-connect',
    createdAt: timestamp,
    lastActivityAt: timestamp,
    userMirrorSince: timestamp,
    status: 'active',
  });
  const sessionBridge = dependencies.getSessionBridge?.();
  await dependencies.streamHandler.subscribe(threadId, sessionId, client, sessionBridge?.getDedupeSet(threadId), projectPath);
  await sendThreadNotice(thread, `세션 \`${sessionId}\`에 자동으로 연결했습니다.`);
  if (sessionBridge !== undefined) {
    await warnOnFailure(logger, 'Failed to replay auto-connected session history', { threadId, sessionId, projectPath }, async () => {
      await sessionBridge.replaySessionHistory({
        client: client as OpencodeSessionClient,
        threadId,
        guildId: channel.guildId,
        channelId: channel.channel.channelId,
        projectPath,
        sessionId,
        agent: channel.channel.defaultAgent ?? 'build',
        model: null,
        createdBy: 'auto-connect',
        historyLimit: channel.channel.connectHistoryLimit === 0 ? undefined : channel.channel.connectHistoryLimit ?? 30,
        thread: thread as unknown as HistoryThreadLike,
      });
    });
  }
}

async function ensureProjectChannel(
  projectPath: string,
  dependencies: DefaultAutoConnectDependencies,
): Promise<{ guildId: string; channel: BotConfig['servers'][number]['channels'][number] } | undefined> {
  const configured = getFirstAutoConnectChannel(dependencies.config, projectPath);
  if (configured === undefined) return undefined;
  try {
    return await dependencies.discordClient.channels?.fetch(configured.channel.channelId) ? configured : undefined;
  } catch {
    logger.warn('설정된 프로젝트 채널이 없습니다. 설정을 다시 확인하세요', { projectPath, channelId: configured.channel.channelId });
    return undefined;
  }
}

function getFirstAutoConnectChannel(config: BotConfig, projectPath: string): { guildId: string; channel: BotConfig['servers'][number]['channels'][number] } | undefined {
  for (const server of config.servers) {
    for (const channel of server.channels) {
      if (channel.projectPath === projectPath && channel.autoConnect === true) {
        return { guildId: server.serverId, channel };
      }
    }
  }

  return undefined;
}

function hasThreadCreate(channel: unknown): channel is { threads: { create(options: { name: string }): Promise<unknown> | unknown } } {
  return isRecord(channel) && isRecord(channel.threads) && typeof channel.threads.create === 'function';
}

function getSessionTitle(session: unknown, sessionId: string): string {
  if (isRecord(session) && typeof session.title === 'string' && session.title.trim() !== '') {
    return session.title;
  }

  return sessionId;
}

async function listClientSessions(client: unknown, projectPath: string | undefined): Promise<unknown[]> {
  if (!isRecord(client) || !isRecord(client.session) || typeof client.session.list !== 'function') {
    return [];
  }

  const response = await client.session.list();
  const envelope = isRecord(response) && 'data' in response ? response.data : response;
  const sessions = isRecord(envelope) && 'data' in envelope ? envelope.data : envelope;
  return Array.isArray(sessions) ? filterSessionsByProject(sessions, projectPath) : [];
}

function filterSessionsByProject(sessions: unknown[], projectPath: string | undefined): unknown[] {
  if (projectPath === undefined) {
    return sessions;
  }
  return sessions.filter((session) => {
    const sessionPath = getSessionProjectPath(session);
    if (sessionPath === undefined) {
      return true;
    }

    return sessionPath === projectPath;
  });
}

function getSessionProjectPath(session: unknown): string | undefined {
  if (!isRecord(session)) {
    return undefined;
  }
  const location = isRecord(session.location) ? session.location : undefined;
  return typeof location?.directory === 'string'
    ? location.directory
    : typeof session.directory === 'string' ? session.directory : undefined;
}

function getSessionCreatedAt(session: unknown): number {
  if (!isRecord(session) || !isRecord(session.time) || typeof session.time.created !== 'number') {
    return 0;
  }
  return session.time.created;
}

function getSessionUpdatedAt(session: unknown): number {
  if (!isRecord(session) || !isRecord(session.time)) {
    return 0;
  }
  return typeof session.time.updated === 'number'
    ? session.time.updated
    : typeof session.time.idle === 'number' ? session.time.idle : getSessionCreatedAt(session);
}

function getSessionId(session: unknown): string | undefined {
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

function getAutoConnectProjects(config: BotConfig): Set<string> {
  const projects = new Set<string>();
  for (const server of config.servers) {
    for (const channel of server.channels) {
      if (channel.autoConnect === true) {
        projects.add(channel.projectPath);
      }
    }
  }

  return projects;
}

async function warnOnFailure(
  warningLogger: Pick<Logger, 'warn'>,
  message: string,
  meta: Record<string, unknown>,
  operation: () => Promise<void> | void,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    warningLogger.warn(message, { ...meta, error });
  }
}

interface ThreadResolver {
  fetch(threadId: string): Promise<unknown>;
  getCached(threadId: string): StreamThread | undefined;
  remember(threadId: string, thread: unknown): void;
}

function createDiscordThreadResolver(discordClient: DiscordClientLike, resolverLogger: Pick<Logger, 'warn'>): ThreadResolver {
  const threads = new Map<string, unknown>();

  return {
    async fetch(threadId: string): Promise<unknown> {
      if (threads.has(threadId)) {
        return threads.get(threadId);
      }

      if (discordClient.channels === undefined) {
        return undefined;
      }

      let thread: unknown;
      try {
        thread = await discordClient.channels.fetch(threadId);
      } catch (error) {
        resolverLogger.warn('Failed to fetch Discord thread during startup recovery', { threadId, error });
        return undefined;
      }

      if (thread !== undefined && thread !== null) {
        threads.set(threadId, thread);
      }

      return thread;
    },
    getCached(threadId: string): StreamThread | undefined {
      const thread = threads.get(threadId);
      return isStreamThread(thread) ? thread : undefined;
    },
    remember(threadId: string, thread: unknown): void {
      threads.set(threadId, thread);
    },
  };
}

function isStreamThread(thread: unknown): thread is StreamThread {
  return isRecord(thread) && typeof thread.send === 'function';
}

function createDefaultStreamHandler(options: StartupStreamHandlerOptions): StreamHandlerLike {
  return new StreamHandler({
    getThread: options.getThread,
    getEventClient: options.getEventClient,
    questionHandler: options.questionHandler,
    permissionHandler: options.permissionHandler,
    onUserMessage: options.onUserMessage,
    autoConnectHandler: options.autoConnectHandler,
  });
}

async function abortSessionFromServerManager(
  serverManager: ServerManagerLike,
  recoveredClients: Map<string, unknown>,
  threadId: string,
  session: SessionState,
  abortLogger: Pick<Logger, 'warn'>,
): Promise<void> {
  const client = serverManager.getClient(session.projectPath) ?? recoveredClients.get(session.projectPath);
  if (!isRecord(client) || !isRecord(client.session) || typeof client.session.abort !== 'function') {
    return;
  }

  const sessionApi = client.session as { abort(options: { sessionID: string }): Promise<void> | void };
  await warnOnFailure(abortLogger, 'Failed to abort OpenCode session during lifecycle shutdown', {
    threadId,
    sessionId: session.sessionId,
    projectPath: session.projectPath,
  }, async () => {
    await sessionApi.abort({ sessionID: session.sessionId });
  });
}

async function cleanupRemovedChannelSessions(
  guildId: string,
  channelId: string,
  stateManager: StateManagerLike,
  serverManager: ServerManagerLike,
  recoveredClients: Map<string, unknown>,
  threadResolver: ThreadResolver,
  cleanupLogger: Pick<Logger, 'warn'>,
): Promise<void> {
  for (const [threadId, session] of Object.entries(stateManager.getState().sessions)) {
    if (session.guildId !== guildId || session.channelId !== channelId || session.status === 'ended') {
      continue;
    }

    await abortSessionFromServerManager(serverManager, recoveredClients, threadId, session, cleanupLogger);
    stateManager.setSession(threadId, { ...session, status: 'ended' });
    stateManager.clearQueue(threadId);
    const thread = threadResolver.getCached(threadId) ?? await threadResolver.fetch(threadId);
    await warnOnFailure(cleanupLogger, 'Failed to notify removed-channel thread cleanup', { threadId }, async () => {
      await sendThreadNotice(thread, '설정에서 채널이 제거되어 세션을 종료했습니다.');
    });
    await warnOnFailure(cleanupLogger, 'Failed to archive removed-channel thread', { threadId }, async () => {
      if (hasSetArchived(thread)) {
        await thread.setArchived(true);
      }
    });
  }
}

function wrapLifecycleController(
  lifecycleController: LifecycleController,
  cleanup: () => Promise<void>,
): LifecycleController {
  const closeWatcher = async (): Promise<void> => {
    await cleanup();
  };

  return {
    runInactivityCheck: () => lifecycleController.runInactivityCheck(),
    shutdown: async () => {
      await closeWatcher();
      await lifecycleController.shutdown();
    },
    dispose: () => {
      void closeWatcher();
      lifecycleController.dispose();
    },
  };
}

async function shutdownRecoveredServers(
  recoveredClients: Map<string, unknown>,
  stateManager: StateManagerLike,
  killPid: (pid: number) => void,
  shutdownLogger: Pick<Logger, 'warn'>,
): Promise<void> {
  for (const projectPath of recoveredClients.keys()) {
    const server = stateManager.getState().servers[projectPath];
    if (server === undefined || server.status !== 'running') {
      continue;
    }

    await warnOnFailure(shutdownLogger, 'Failed to kill recovered OpenCode process during lifecycle shutdown', {
      projectPath,
      pid: server.pid,
    }, () => {
      killPid(server.pid);
    });
    stateManager.setServer(projectPath, { ...server, status: 'stopped' });
  }
}

function asLifecycleLogger(startupLogger: Pick<Logger, 'warn' | 'error'>): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (msg, meta) => startupLogger.warn(msg, meta),
    error: (msg, meta) => startupLogger.error(msg, meta),
  };
}

function asLifecycleClient(discordClient: DiscordClientLike): Parameters<typeof defaultRegisterLifecycleHandlers>[0] {
  return {
    channels: {
      fetch: async (threadId: string) => {
        const thread = await discordClient.channels?.fetch(threadId);
        return hasSetArchived(thread) ? thread : null;
      },
    },
    destroy: () => {
      discordClient.destroy?.();
    },
    on: (eventName, listener) => {
      discordClient.on?.(eventName, listener as (...args: unknown[]) => void);
    },
    off: (eventName, listener) => {
      discordClient.off?.(eventName, listener as (...args: unknown[]) => void);
    },
  };
}

function hasSetArchived(thread: unknown): thread is { setArchived(archived: boolean): Promise<unknown> } {
  return isRecord(thread) && typeof thread.setArchived === 'function';
}

async function sendThreadNotice(thread: unknown, message: string): Promise<void> {
  if (!isRecord(thread) || typeof thread.send !== 'function') {
    return;
  }

  await thread.send(suppressLinkPreviews(message));
}

async function defaultPreflight(): Promise<void> {
  try {
    await execFileAsync(getOpenCodeExecutable(), ['--version']);
  } catch (error) {
    throw new BotError(ErrorCode.SERVER_START_FAILED, 'OpenCode CLI was not found in PATH. Install opencode before starting the bot.', {
      error,
    });
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillPid(pid: number): void {
  process.kill(pid, 'SIGKILL');
}

async function defaultHealthCheck(client: unknown): Promise<boolean> {
  if (!isRecord(client) || !isRecord(client.global) || typeof client.global.health !== 'function') {
    return false;
  }

  try {
    const result = await client.global.health();
    return isRecord(result) && (result.healthy === true || (isRecord(result.data) && result.data.healthy === true));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

if (isDirectEntrypoint(import.meta.url, process.argv)) {
  void runCli();
}
