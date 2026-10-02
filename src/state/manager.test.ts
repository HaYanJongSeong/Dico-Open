import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateManager } from './manager.js';
import type { QueueEntry, ServerState, SessionState } from './types.js';

describe('StateManager', () => {
  let tmpDir: string;
  let statePath: string;
  let manager: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
    statePath = path.join(tmpDir, 'state.json');
    manager = new StateManager(statePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('creates empty state when file does not exist', () => {
      manager.load();
      expect(manager.getState().version).toBe(1);
      expect(manager.getState().servers).toEqual({});
      expect(manager.getState().sessions).toEqual({});
      expect(manager.getState().queues).toEqual({});
    });

    it('loads existing state from disk', () => {
      const existing = {
        version: 1,
        servers: {},
        sessions: { thread1: { sessionId: 'sess_1', status: 'active' } },
        queues: {},
      };
      fs.writeFileSync(statePath, JSON.stringify(existing));
      manager.load();
      expect(manager.getSession('thread1')?.sessionId).toBe('sess_1');
    });
  });

  describe('getState', () => {
    it('returns a snapshot that cannot mutate internal state without persistence', () => {
      manager.load();
      manager.setSession('thread1', {
        sessionId: 'sess_1',
        guildId: 'g1',
        channelId: 'c1',
        projectPath: '/tmp/p',
        agent: 'code',
        model: null,
        createdBy: 'u1',
        createdAt: 1000,
        lastActivityAt: 1000,
        status: 'active',
      });

      const snapshot = manager.getState();
      snapshot.sessions.thread1!.sessionId = 'mutated';
      snapshot.queues.thread1 = [{ userId: 'u1', content: 'bypass', attachments: [], queuedAt: 1000 }];

      expect(manager.getSession('thread1')?.sessionId).toBe('sess_1');
      expect(manager.getQueue('thread1')).toEqual([]);
    });
  });

  describe('save', () => {
    it('writes state to disk atomically', () => {
      manager.load();
      manager.setSession('thread1', {
        sessionId: 'sess_1',
        guildId: 'g1',
        channelId: 'c1',
        projectPath: '/tmp/p',
        agent: 'code',
        model: null,
        createdBy: 'u1',
        createdAt: 1000,
        lastActivityAt: 1000,
        status: 'active',
      });
      const raw = fs.readFileSync(statePath, 'utf-8');
      const parsed = JSON.parse(raw) as { sessions: Record<string, SessionState> };
      expect(parsed.sessions.thread1?.sessionId).toBe('sess_1');
    });

    it('temp file does not persist after save', () => {
      manager.load();
      manager.setSession('t1', {
        sessionId: 's1',
        guildId: 'g',
        channelId: 'c',
        projectPath: '/p',
        agent: 'a',
        model: null,
        createdBy: 'u',
        createdAt: 0,
        lastActivityAt: 0,
        status: 'active',
      });
      const tmpFile = `${statePath}.tmp`;
      expect(fs.existsSync(tmpFile)).toBe(false);
    });
  });

  describe('session accessors', () => {
    it('setSession and getSession', () => {
      manager.load();
      const session: SessionState = {
        sessionId: 'sess_x',
        guildId: 'g1',
        channelId: 'c1',
        projectPath: '/p',
        agent: 'build',
        model: 'anthropic/claude-sonnet-4-20250514',
        createdBy: 'u1',
        createdAt: 100,
        lastActivityAt: 100,
        status: 'active',
      };
      manager.setSession('thread_x', session);
      expect(manager.getSession('thread_x')).toEqual(session);
    });

    it('removeSession', () => {
      manager.load();
      manager.setSession('t1', {
        sessionId: 's1',
        guildId: 'g',
        channelId: 'c',
        projectPath: '/p',
        agent: 'a',
        model: null,
        createdBy: 'u',
        createdAt: 0,
        lastActivityAt: 0,
        status: 'active',
      });
      manager.removeSession('t1');
      expect(manager.getSession('t1')).toBeUndefined();
    });
  });

  describe('server accessors', () => {
    it('setServer and getServer', () => {
      manager.load();
      const server: ServerState = {
        port: 3000,
        pid: 123,
        url: 'http://127.0.0.1:3000',
        startedAt: 100,
        status: 'running',
      };
      manager.setServer('/path/project', server);
      expect(manager.getServer('/path/project')).toEqual(server);
    });
  });

  describe('queue accessors', () => {
    it('enqueue and getQueue', () => {
      manager.load();
      const entry: QueueEntry = {
        userId: 'u1',
        content: 'hello',
        attachments: [],
        queuedAt: 100,
      };
      manager.enqueue('thread1', entry);
      expect(manager.getQueue('thread1')).toEqual([entry]);
    });

    it('dequeue returns first entry', () => {
      manager.load();
      manager.enqueue('t1', {
        userId: 'u',
        content: 'first',
        attachments: [],
        queuedAt: 1,
      });
      manager.enqueue('t1', {
        userId: 'u',
        content: 'second',
        attachments: [],
        queuedAt: 2,
      });
      const entry = manager.dequeue('t1');
      expect(entry?.content).toBe('first');
      expect(manager.getQueue('t1')).toHaveLength(1);
    });

    it('clearQueue empties thread queue', () => {
      manager.load();
      manager.enqueue('t1', {
        userId: 'u',
        content: 'msg',
        attachments: [],
        queuedAt: 1,
      });
      manager.clearQueue('t1');
      expect(manager.getQueue('t1')).toEqual([]);
    });
  });
});
