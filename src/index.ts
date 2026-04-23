/** Entry point — initialize DB, start bot, handle graceful shutdown. */

import { initDb, closeDb } from "./db.ts";
import { initMemoryDb } from "./memory.ts";
import { warmEmbedder } from "./extraction.ts";
import { createBot, ensureOutputDir } from "./bot.ts";
import { cleanupOldImages } from "./image-handler.ts";
import { config } from "./config.ts";

console.log("[claudeclaw] Starting...");

// Initialize database
initDb();
initMemoryDb();
console.log("[claudeclaw] Database initialized");

// Ensure agent-output image dir exists for [TG_IMAGE: path] responses
ensureOutputDir();

// Pre-download BGE embedding model so first user message has warm cache
if (config.memoryEnabled) {
  warmEmbedder();
} else {
  console.log("[claudeclaw] Memory DISABLED (MEMORY_ENABLED=false) — skipping embedder warmup");
}

// Clean up stale photo downloads on boot
const removed = cleanupOldImages();
if (removed > 0) console.log(`[claudeclaw] Cleaned ${removed} stale image(s)`);

// Periodic image cleanup — every 6 hours
const imageCleanupTimer = setInterval(() => {
  const n = cleanupOldImages();
  if (n > 0) console.log(`[claudeclaw] Cleaned ${n} stale image(s)`);
}, 6 * 60 * 60 * 1000);

// Create and start bot
const bot = createBot();

// Graceful shutdown
function shutdown(signal: string): void {
  console.log(`[claudeclaw] Received ${signal}, shutting down...`);
  clearInterval(imageCleanupTimer);
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
