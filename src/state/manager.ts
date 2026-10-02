import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { EMPTY_STATE } from './types.js';
import type { BotState, QueueEntry, ServerState, SessionState } from './types.js';

const logger = createLogger('StateManager');

/**
 * Manages bot runtime state with atomic persistence to disk.
 */
export class StateManager {
  private state: BotState = { ...EMPTY_STATE, servers: {}, sessions: {}, queues: {} };
  private readonly statePath: string;

  /**
   * Create a state manager for the given state file path.
   * @param statePath - Path to the persisted state JSON file
   */
  constructor(statePath: string) {
    this.statePath = statePath;
  }

  /**
   * Load state from disk, or initialize empty state if the file does not exist.
   * @returns Nothing
   */
  load(): void {
    if (fs.existsSync(this.statePath)) {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      this.state = JSON.parse(raw) as BotState;
      logger.info('상태 파일 로드 완료', {
        sessions: Object.keys(this.state.sessions).length,
      });
      return;
    }

    this.state = { ...EMPTY_STATE, servers: {}, sessions: {}, queues: {} };
    logger.info('상태 파일 없음. 새 상태로 시작');
  }

  /**
   * Get a snapshot of the current state.
   * @returns Deep-cloned current bot state
   */
  getState(): BotState {
    return structuredClone(this.state);
  }

  /**
   * Get session state for a Discord thread.
   * @param threadId - Discord thread ID
   * @returns Session state, or undefined when absent
   */
  getSession(threadId: string): SessionState | undefined {
    return this.state.sessions[threadId];
  }

  /**
   * Set session state for a Discord thread and persist immediately.
   * @param threadId - Discord thread ID
   * @param session - Session state to store
   * @returns Nothing
   */
  setSession(threadId: string, session: SessionState): void {
    this.state.sessions[threadId] = session;
    this.save();
  }

  /**
   * Remove session state for a Discord thread and persist immediately.
   * @param threadId - Discord thread ID
   * @returns Nothing
   */
  removeSession(threadId: string): void {
    delete this.state.sessions[threadId];
    this.save();
  }

  /**
   * Get server state for a project path.
   * @param projectPath - Project path used as server key
   * @returns Server state, or undefined when absent
   */
  getServer(projectPath: string): ServerState | undefined {
    return this.state.servers[projectPath];
  }

  /**
   * Set server state for a project path and persist immediately.
   * @param projectPath - Project path used as server key
   * @param server - Server state to store
   * @returns Nothing
   */
  setServer(projectPath: string, server: ServerState): void {
    this.state.servers[projectPath] = server;
    this.save();
  }

  /**
   * Remove server state for a project path and persist immediately.
   * @param projectPath - Project path used as server key
   * @returns Nothing
   */
  removeServer(projectPath: string): void {
    delete this.state.servers[projectPath];
    this.save();
  }

  /**
   * Get queued entries for a Discord thread.
   * @param threadId - Discord thread ID
   * @returns Queue entries, or an empty array when absent
   */
  getQueue(threadId: string): QueueEntry[] {
    return this.state.queues[threadId] ?? [];
  }

  /**
   * Add a queue entry for a Discord thread and persist immediately.
   * @param threadId - Discord thread ID
   * @param entry - Queue entry to append
   * @returns Nothing
   */
  enqueue(threadId: string, entry: QueueEntry): void {
    this.state.queues[threadId] ??= [];
    this.state.queues[threadId].push(entry);
    this.save();
  }

  /**
   * Remove and return the oldest queued entry for a Discord thread.
   * @param threadId - Discord thread ID
   * @returns Oldest queue entry, or undefined when empty
   */
  dequeue(threadId: string): QueueEntry | undefined {
    const queue = this.state.queues[threadId];
    if (!queue || queue.length === 0) {
      return undefined;
    }

    const entry = queue.shift();
    this.save();
    return entry;
  }

  /**
   * Clear queued entries for a Discord thread and persist immediately.
   * @param threadId - Discord thread ID
   * @returns Nothing
   */
  clearQueue(threadId: string): void {
    this.state.queues[threadId] = [];
    this.save();
  }

  /**
   * Persist state atomically by writing a temp file and renaming it into place.
   */
  private save(): void {
    const tmpPath = `${this.statePath}.tmp`;
    const stateDir = path.dirname(this.statePath);

    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmpPath, this.statePath);
  }
}
