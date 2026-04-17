/** FIFO message queue with per-chat mutex. Prevents race conditions. */

type Task = () => Promise<void>;

const queues = new Map<number, Task[]>();
const processing = new Set<number>();

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
