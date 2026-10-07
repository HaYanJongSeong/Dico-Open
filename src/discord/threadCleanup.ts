import type { SessionState } from '../state/types.js';

/** Archive only an ended mapping whose freshly fetched thread belongs to this bot. */
export async function archiveEndedThread(
  threadId: string,
  session: SessionState,
  dependencies: {
    botUserId: string | undefined;
    fetch(threadId: string): Promise<unknown>;
    getSession(threadId: string): SessionState | undefined;
    warn(message: string, meta: Record<string, unknown>): void;
  },
): Promise<boolean> {
  if (session.status !== 'ended' || !dependencies.botUserId) return false;
  try {
    const thread = await dependencies.fetch(threadId);
    const current = dependencies.getSession(threadId);
    if (!current || current.sessionId !== session.sessionId || current.status !== 'ended'
      || current.guildId !== session.guildId || current.channelId !== session.channelId
      || typeof thread !== 'object' || thread === null) return false;
    const candidate = thread as {
      id?: string; ownerId?: string; guildId?: string; parentId?: string; archived?: boolean;
      isThread?: () => boolean; setArchived?: (archived: boolean) => Promise<unknown>;
    };
    if (candidate.id !== threadId || candidate.ownerId !== dependencies.botUserId
      || candidate.guildId !== current.guildId || candidate.parentId !== current.channelId
      || candidate.archived !== false || candidate.isThread?.() !== true
      || typeof candidate.setArchived !== 'function') return false;
    await candidate.setArchived(true);
    return true;
  } catch (error) {
    dependencies.warn('종료된 Discord 스레드 보관 실패; 다음 동기화에서 재시도합니다', {
      threadId, sessionId: session.sessionId, error,
    });
    return false;
  }
}
