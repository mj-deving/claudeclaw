/** FIFO message queue with per-chat mutex. Prevents race conditions. */

type Task = () => Promise<void>;

const queues = new Map<number, Task[]>();
const processing = new Set<number>();

/**
 * Drop all PENDING tasks for a chat (does not cancel the currently running one).
 * Used by /stop on Telegram so a wedged session doesn't fire queued messages
 * after the abort.
 *
 * Returns the count of tasks dropped.
 */
export function drainQueue(chatId: number): number {
  const queue = queues.get(chatId);
  if (!queue) return 0;
  const n = queue.length;
  queue.length = 0;
  return n;
}

/**
 * Enqueue a task for a specific chat. Tasks for the same chat_id
 * execute sequentially (FIFO). Different chat_ids run in parallel.
 */
export function enqueue(chatId: number, task: Task): void {
  const queue = queues.get(chatId) ?? [];
  queue.push(task);
  queues.set(chatId, queue);

  if (!processing.has(chatId)) {
    void processQueue(chatId);
  }
}

async function processQueue(chatId: number): Promise<void> {
  processing.add(chatId);

  try {
    while (true) {
      const queue = queues.get(chatId);
      if (!queue || queue.length === 0) break;

      const task = queue.shift()!;
      try {
        await task();
      } catch (err) {
        console.error(`[queue] Error processing chat ${chatId}:`, err);
      }
    }
  } finally {
    queues.delete(chatId);
    processing.delete(chatId);
  }
}
