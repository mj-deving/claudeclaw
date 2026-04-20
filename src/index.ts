/** Entry point — initialize DB, start bot, handle graceful shutdown. */

import { initDb, closeDb } from "./db.ts";
import { initMemoryDb } from "./memory.ts";
import { createBot } from "./bot.ts";

console.log("[claudeclaw] Starting...");

// Initialize database
initDb();
initMemoryDb();
console.log("[claudeclaw] Database initialized");

// Create and start bot
const bot = createBot();

// Graceful shutdown
function shutdown(signal: string): void {
  console.log(`[claudeclaw] Received ${signal}, shutting down...`);
  bot.stop();
  closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Start with long polling
bot.start({
  onStart: () => {
    console.log("[claudeclaw] Bot is running");
  },
});
