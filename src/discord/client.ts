import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';
import type { BotState, ServerState, SessionState } from '../state/types.js';

const logger = createLogger('DiscordLifecycle');
const INACTIVITY_LIMIT_MS = 24 * 60 * 60 * 1000;
const INACTIVITY_INTERVAL_MS = 30 * 60 * 1000;
type IntervalHandle = Parameters<typeof clearInterval>[0];

interface StateManagerLike {
  getState(): BotState;
  getSession(threadId: string): SessionState | undefined;
  setSession(threadId: string, session: SessionState): void;
  setServer(projectPath: string, server: ServerState): void;
}

interface ServerManagerLike {
  shutdownAll(): Promise<void>;
}

interface ProcessLike {
  on(eventName: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(eventName: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

interface ThreadLike {
  id: string;
}

interface ArchivableThreadLike {
  setArchived(archived: boolean): Promise<unknown>;
}

interface ClientLike {
  on(eventName: 'threadDelete', listener: (thread: ThreadLike) => void): unknown;
  off?(eventName: 'threadDelete', listener: (thread: ThreadLike) => void): unknown;
  channels: {
    fetch(threadId: string): Promise<ArchivableThreadLike | null>;
  };
  destroy(): void;
}

/** Runtime dependencies for lifecycle event handling. */
export interface LifecycleHandlerOptions {
  stateManager: StateManagerLike;
  serverManager: ServerManagerLike;
  abortSession: (threadId: string, session: SessionState) => Promise<void>;
  processLike?: ProcessLike;
  setInterval?: (handler: () => void, timeout: number) => IntervalHandle;
  clearInterval?: (timer: IntervalHandle) => void;
  exit?: (code: number) => void;
  now?: () => number;
  logger?: Logger;
}

/** Controller returned when lifecycle handlers are registered. */
export interface LifecycleController {
  runInactivityCheck(): Promise<void>;
  shutdown(): Promise<void>;
  dispose(): void;
}

/**
 * Creates a Discord client configured for guild message handling.
 *
 * @param token - Discord bot token accepted by the factory for caller configuration.
 * @returns A configured Discord.js client instance.
 */
export function createDiscordClient(token: string): Client {
  void token;

  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageTyping,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.ThreadMember],
  });
}

/**
 * Register Discord lifecycle, inactivity, and process shutdown handlers.
 *
 * @param client - Discord client or structurally compatible test double
 * @param options - Injected state, server, timing, process, and logging dependencies
 * @returns Lifecycle controller for deterministic checks, shutdown, and disposal
 */
export function registerLifecycleHandlers(
  client: ClientLike,
  options: LifecycleHandlerOptions,
): LifecycleController {
  const log = options.logger ?? logger;
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const processLike = options.processLike ?? process;
  const exit = options.exit ?? process.exit;
  let shuttingDown: Promise<void> | undefined;
  let disposed = false;
  let timer: IntervalHandle;

  const warn = (msg: string, meta?: Record<string, unknown>): void => {
    log.warn(msg, meta);
  };

  const markSession = (threadId: string, session: SessionState, status: SessionState['status']): SessionState => {
    const nextSession = {
      ...session,
      status,
    };
    options.stateManager.setSession(threadId, nextSession);
    return nextSession;
  };

  const abortBestEffort = async (threadId: string, session: SessionState): Promise<void> => {
    try {
      await options.abortSession(threadId, session);
    } catch (error) {
      warn('Session abort failed during lifecycle handling', { threadId, sessionId: session.sessionId, error });
    }
  };

  const handleThreadDelete = (thread: ThreadLike): void => {
    const session = options.stateManager.getSession(thread.id);
    if (session === undefined || session.status === 'ended') {
      return;
    }

    const endedSession = markSession(thread.id, session, 'ended');
    void (async () => {
      await abortBestEffort(thread.id, endedSession);
    })();
  };

  const runInactivityCheck = async (): Promise<void> => {
    const state = options.stateManager.getState();
    const cutoff = now() - INACTIVITY_LIMIT_MS;

    for (const [threadId, session] of Object.entries(state.sessions)) {
      if (session.status !== 'active' || session.lastActivityAt >= cutoff) {
        continue;
      }

      try {
        const thread = await client.channels.fetch(threadId);
        await thread?.setArchived(true);
      } catch (error) {
        warn('Thread archive failed during inactivity handling', { threadId, sessionId: session.sessionId, error });
      }

      markSession(threadId, session, 'inactive');
    }
  };

  const shutdown = async (): Promise<void> => {
    shuttingDown ??= (async () => {
      dispose();
      const state = options.stateManager.getState();

      for (const [threadId, session] of Object.entries(state.sessions)) {
        if (session.status !== 'ended') {
          await abortBestEffort(threadId, session);
        }
      }

      try {
        await options.serverManager.shutdownAll();
      } catch (error) {
        warn('Server shutdown failed during bot shutdown', { error });
      }

      for (const [projectPath, server] of Object.entries(state.servers)) {
        options.stateManager.setServer(projectPath, {
          ...server,
          status: 'stopped',
        });
      }
    })();

    client.destroy();

    await shuttingDown;
  };

  const handleSignal = (): void => {
    void (async () => {
      await shutdown();
      exit(0);
    })();
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    clearIntervalFn(timer);
    client.off?.('threadDelete', handleThreadDelete);
    processLike.off('SIGINT', handleSignal);
    processLike.off('SIGTERM', handleSignal);
  };

  client.on('threadDelete', handleThreadDelete);
  processLike.on('SIGINT', handleSignal);
  processLike.on('SIGTERM', handleSignal);
  timer = setIntervalFn(() => {
    void runInactivityCheck();
  }, INACTIVITY_INTERVAL_MS);

  return {
    runInactivityCheck,
    shutdown,
    dispose,
  };
}
