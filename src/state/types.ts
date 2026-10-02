/** Status of a managed opencode serve process */
export type ServerStatus = 'running' | 'stopped' | 'starting';

/** Persisted information about an opencode serve process */
export interface ServerState {
  port: number;
  pid: number;
  url: string;
  startedAt: number;
  status: ServerStatus;
}

/** Session status in the bot's lifecycle */
export type SessionStatus = 'active' | 'inactive' | 'ended';

/** Persisted information about a session mapping */
export interface SessionState {
  sessionId: string;
  guildId: string;
  channelId: string;
  projectPath: string;
  agent: string;
  model: string | null;
  createdBy: string;
  createdAt: number;
  lastActivityAt: number;
  lastSyncedMessageId?: string;
  lastSyncedMessageContent?: string;
  userMirrorSince?: number;
  lastSyncedUserMessageId?: string;
  lastSyncedUserAt?: number;
  imageMirrorSince?: number;
  syncedImageHashes?: string[];
  historyStartMessageId?: string;
  status: SessionStatus;
}

/** A queued message waiting to be sent to the agent */
export interface QueueEntry {
  userId: string;
  content: string;
  attachments: string[];
  queuedAt: number;
}

/** Root state schema persisted to state.json */
export interface BotState {
  version: number;
  servers: Record<string, ServerState>;
  sessions: Record<string, SessionState>;
  queues: Record<string, QueueEntry[]>;
}

/** Empty initial state */
export const EMPTY_STATE: BotState = {
  version: 1,
  servers: {},
  sessions: {},
  queues: {},
};
