/** Entry point — initialize DB, start bot, handle graceful shutdown. */

import { initDb, closeDb } from "./db.ts";
import { initMemoryDb } from "./memory.ts";
import { warmEmbedder } from "./extraction.ts";
import { createBot, ensureOutputDir } from "./bot.ts";
import { cleanupOldImages } from "./image-handler.ts";
import { abortAll } from "./agent.ts";
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

// Graceful shutdown — abort in-flight SDK runs first so spawned subprocesses
// (codex, etc.) get the cancel signal instead of orphaning the cgroup.
function shutdown(signal: string): void {
  console.log(`[claudeclaw] Received ${signal}, shutting down...`);

  const aborted = abortAll();
  if (aborted > 0) console.log(`[claudeclaw] Aborted ${aborted} in-flight run(s)`);

  // Hard fallback — if cleanup wedges (stuck SDK Stop hooks, etc.) force exit
  // after 10s rather than let systemd wait the full TimeoutStopSec.
  setTimeout(() => {
    console.warn("[claudeclaw] Shutdown timeout (10s) — forcing exit(1)");
    process.exit(1);
  }, 10_000).unref();

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
