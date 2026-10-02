import type { QueueEntry } from '../state/types.js';

/**
 * Per-thread in-memory message queue with FIFO ordering and deduplication.
 */
export class MessageQueue {
  private readonly queues = new Map<string, QueueEntry[]>();
  private readonly recentContent = new Map<string, Set<string>>();

  /**
   * Add a message to a thread's queue. Deduplicates by content within that thread.
   * @param threadId - Discord thread ID.
   * @param entry - Queue entry to add.
   * @returns Nothing.
   */
  enqueue(threadId: string, entry: QueueEntry): void {
    if (!this.queues.has(threadId)) {
      this.queues.set(threadId, []);
      this.recentContent.set(threadId, new Set());
    }

    const recent = this.recentContent.get(threadId);
    if (recent?.has(entry.content)) {
      return;
    }

    recent?.add(entry.content);
    this.queues.get(threadId)?.push(entry);
  }

  /**
   * Remove and return the first entry from a thread's queue.
   * @param threadId - Discord thread ID.
   * @returns First queue entry, or undefined if empty.
   */
  dequeue(threadId: string): QueueEntry | undefined {
    const queue = this.queues.get(threadId);
    if (!queue || queue.length === 0) {
      return undefined;
    }

    const entry = queue.shift();
    if (entry) {
      this.recentContent.get(threadId)?.delete(entry.content);
    }

    return entry;
  }

  /**
   * List all entries in a thread's queue without removing them.
   * @param threadId - Discord thread ID.
   * @returns Array of queue entries.
   */
  list(threadId: string): QueueEntry[] {
    return [...(this.queues.get(threadId) ?? [])];
  }

  /**
   * Clear all entries in a thread's queue.
   * @param threadId - Discord thread ID.
   * @returns Nothing.
   */
  clear(threadId: string): void {
    this.queues.set(threadId, []);
    this.recentContent.set(threadId, new Set());
  }

  /**
   * Get the number of entries in a thread's queue.
   * @param threadId - Discord thread ID.
   * @returns Number of queued messages.
   */
  size(threadId: string): number {
    return this.queues.get(threadId)?.length ?? 0;
  }
}
