import { beforeEach, describe, expect, it } from 'vitest';
import { MessageQueue } from './messageQueue.js';

describe('MessageQueue', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue();
  });

  it('enqueues and dequeues in FIFO order', () => {
    queue.enqueue('thread1', { userId: 'u1', content: 'first', attachments: [], queuedAt: 1 });
    queue.enqueue('thread1', { userId: 'u1', content: 'second', attachments: [], queuedAt: 2 });

    expect(queue.dequeue('thread1')?.content).toBe('first');
    expect(queue.dequeue('thread1')?.content).toBe('second');
  });

  it('returns undefined when dequeuing empty queue', () => {
    expect(queue.dequeue('nonexistent')).toBeUndefined();
  });

  it('lists queue contents', () => {
    queue.enqueue('t1', { userId: 'u', content: 'a', attachments: [], queuedAt: 1 });
    queue.enqueue('t1', { userId: 'u', content: 'b', attachments: [], queuedAt: 2 });

    expect(queue.list('t1')).toHaveLength(2);
  });

  it('clears a thread queue', () => {
    queue.enqueue('t1', { userId: 'u', content: 'msg', attachments: [], queuedAt: 1 });
    queue.clear('t1');

    expect(queue.list('t1')).toHaveLength(0);
  });

  it('tracks queue size per thread', () => {
    queue.enqueue('t1', { userId: 'u', content: 'a', attachments: [], queuedAt: 1 });
    queue.enqueue('t1', { userId: 'u', content: 'b', attachments: [], queuedAt: 2 });

    expect(queue.size('t1')).toBe(2);
    expect(queue.size('t2')).toBe(0);
  });

  it('deduplicates by message content within same thread', () => {
    queue.enqueue('t1', { userId: 'u', content: 'same', attachments: [], queuedAt: 1 });
    queue.enqueue('t1', { userId: 'u', content: 'same', attachments: [], queuedAt: 2 });

    expect(queue.size('t1')).toBe(1);
  });

  it('prevents list callers from mutating queue state', () => {
    queue.enqueue('t1', { userId: 'u', content: 'same', attachments: [], queuedAt: 1 });

    queue.list('t1').pop();
    queue.enqueue('t1', { userId: 'u', content: 'same', attachments: [], queuedAt: 2 });

    expect(queue.size('t1')).toBe(1);
    expect(queue.dequeue('t1')?.queuedAt).toBe(1);
  });
});
