import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../state/types.js';
import { archiveEndedThread } from './threadCleanup.js';

function fixture() {
  let session: SessionState = {
    sessionId: 'session-1', guildId: 'guild-1', channelId: 'channel-1', projectPath: '/project',
    agent: 'build', model: null, createdBy: 'user-1', createdAt: 1, lastActivityAt: 1, status: 'ended',
  };
  const thread = {
    id: 'thread-1', ownerId: 'bot-1', guildId: 'guild-1', parentId: 'channel-1',
    archived: false, isThread: () => true,
    setArchived: vi.fn(async () => { thread.archived = true; }),
  };
  const dependencies = {
    botUserId: 'bot-1', fetch: vi.fn(async () => thread), getSession: () => session, warn: vi.fn(),
  };
  return { thread, dependencies, session, reconnect: (next: SessionState) => { session = next; } };
}

describe('종료된 관리 스레드 안전 보관', () => {
  it('대화와 매핑을 유지하고 이미 보관된 스레드는 다시 보관하지 않는다', async () => {
    const { session, thread, dependencies } = fixture();
    expect(await archiveEndedThread('thread-1', session, dependencies)).toBe(true);
    expect(await archiveEndedThread('thread-1', session, dependencies)).toBe(false);
    expect(thread.setArchived).toHaveBeenCalledExactlyOnceWith(true);
    expect(dependencies.getSession()).toBe(session);
    expect(dependencies.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['active', 'inactive'] as const)('정상 %s 연결은 조회·보관하지 않는다', async (status) => {
    const { session, thread, dependencies } = fixture();
    session.status = status;
    expect(await archiveEndedThread('thread-1', session, dependencies)).toBe(false);
    expect(dependencies.fetch).not.toHaveBeenCalled();
    expect(thread.setArchived).not.toHaveBeenCalled();
  });

  it.each([
    { ownerId: 'user-1' }, { guildId: 'other' }, { parentId: 'other' },
    { id: 'other' }, { archived: true }, { isThread: () => false },
  ])('소유자·위치·스레드 상태가 다르면 제외한다: %j', async (attributes) => {
    const { session, thread, dependencies } = fixture();
    Object.assign(thread, attributes);
    expect(await archiveEndedThread('thread-1', session, dependencies)).toBe(false);
    expect(thread.setArchived).not.toHaveBeenCalled();
  });

  it('조회 실패 시 상태를 유지한다', async () => {
    const { session, thread, dependencies } = fixture();
    dependencies.fetch.mockRejectedValueOnce(new Error('network'));
    expect(await archiveEndedThread('thread-1', session, dependencies)).toBe(false);
    expect(dependencies.getSession()).toBe(session);
    expect(thread.setArchived).not.toHaveBeenCalled();
    expect(dependencies.warn).toHaveBeenCalledOnce();
  });

  it('보관 실패 시 매핑을 유지하고 다음 호출에서 재시도한다', async () => {
    const { session, thread, dependencies } = fixture();
    thread.setArchived.mockRejectedValueOnce(new Error('403'));
    expect(await archiveEndedThread('thread-1', session, dependencies)).toBe(false);
    expect(dependencies.getSession()).toBe(session);
    expect(dependencies.warn).toHaveBeenCalledOnce();
    expect(await archiveEndedThread('thread-1', session, dependencies)).toBe(true);
    expect(thread.setArchived).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 'active' as const }, { sessionId: 'session-new' }, { channelId: 'new-parent' },
  ])('최신 조회 중 재연결된 매핑을 보관하지 않는다: %j', async (attributes) => {
    const { session, thread, dependencies, reconnect } = fixture();
    dependencies.fetch.mockImplementationOnce(async () => {
      reconnect({ ...session, ...attributes });
      return thread;
    });
    expect(await archiveEndedThread('thread-1', session, dependencies)).toBe(false);
    expect(thread.setArchived).not.toHaveBeenCalled();
  });
});
