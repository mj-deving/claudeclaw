/** Grammy bot — allowlist, PIN lock, exfiltration guard, streaming responses, voice transcription. */

import { Bot, type Context, InputFile } from "grammy";
import { config } from "./config.ts";
import { getSession, upsertSessionIfEpochMatches, getActiveProject, setActiveProject, clearSession, getClearEpoch } from "./db.ts";
import { enqueue, drainQueue } from "./queue.ts";
import { runAgentWithRetry, abortChat, AbortedError } from "./agent.ts";
import { isLocked, tryUnlock, lock, touchActivity, isPinEnabled } from "./security.ts";
import { scanForSecrets, formatRedactionWarning } from "./exfiltration-guard.ts";
import { capture, type CaptureType, getReviewSummary, triageApprove, triageDiscard, triageView } from "./capture-handler.ts";
import { handleVoiceMessage } from "./voice.ts";
import { takePhotoCombo, handleVoiceComboWithPhoto } from "./combo-buffer.ts";
import { handlePhotoMessage } from "./image-handler.ts";
import { handleDocumentMessage } from "./document-handler.ts";
import { searchMemories, getRecentMemories, clearMemories, deleteMemoryById, countMemories } from "./memory.ts";
import { embedText, extractAndStore } from "./extraction.ts";
import { triggerSelfUpgrade } from "./self-upgrade.ts";
import { TELEGRAM_MAX_LENGTH, formatCostFooter, splitMessage, sendSplitMessages } from "./telegram-utils.ts";

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { extractAndValidateImages, ensureOutputDir, stripSentinelsForDisplay, findSafeSplitBoundary } from "./image-output.ts";
import { registerBotMenu, HELP_TEXT, COMMANDS_TEXT } from "./help.ts";

export { ensureOutputDir };

const DEFAULT_AGENT_ID = "main";
const STREAM_DEBOUNCE_MS = 800;
const STREAM_MIN_CHARS = 100;

const PROJECTS_ROOT = path.join(process.env.HOME ?? "/home", "projects");

/** Cached list of valid project directory names under ~/projects/. */
let projectDirsCache: string[] | null = null;

function getProjectDirs(): string[] {
  if (projectDirsCache) return projectDirsCache;
  try {
    projectDirsCache = readdirSync(PROJECTS_ROOT).filter((name) => {
      try {
        return statSync(path.join(PROJECTS_ROOT, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    projectDirsCache = [];
  }
  return projectDirsCache;
}

/** Invalidate cache so new projects are picked up. Called on /project refresh. */
function refreshProjectDirs(): string[] {
  projectDirsCache = null;
  return getProjectDirs();
}

/**
 * Detect project intent from natural language.
 * Matches: "move to X", "switch to X", "in X,", "in X and"
 * Only returns a match if X is a valid project directory.
 */
function detectProjectIntent(text: string): string | null {
  const dirs = getProjectDirs();
  if (dirs.length === 0) return null;

  // Patterns: "move to <project>", "switch to <project>", "in <project>,"
  const patterns = [
    /\b(?:move|switch|go)\s+to\s+([\w-]+)/i,
    /\bin\s+([\w-]+)[,\s]+(?:and|work|fix|check|do|build|update|add|create|run)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const candidate = match[1]!.toLowerCase();
      const found = dirs.find((d) => d.toLowerCase() === candidate);
      if (found) return found;
    }
  }

  return null;
}

/** Detect explicit capture commands — returns parsed command or null (→ agent path). */
function isCaptureCommand(
  text: string,
): { type: CaptureType; payload: string } | null {
  if (text.startsWith("/add "))
    return { type: "add", payload: text.slice(5).trim() };
  if (text.startsWith("/url "))
    return { type: "url", payload: text.slice(5).trim() };
  if (text.startsWith("/memo "))
    return { type: "memo", payload: text.slice(6).trim() };
  if (text.startsWith("/remind "))
    return { type: "remind", payload: text.slice(8).trim() };

  // Auto-detect: bare URL with no surrounding text → capture as URL
  const trimmed = text.trim();
  if (/^https?:\/\/\S+$/.test(trimmed))
    return { type: "url", payload: trimmed };

  return null;
}

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  // Global error handler
  bot.catch((err) => {
    console.error(
      `[bot] Error for update ${err.ctx.update.update_id}:`,
      err.error,
    );
    err.ctx.reply("Something went wrong. Please try again.").catch(() => {});
  });

  // Allowlist middleware — reject unauthorized users
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !config.allowedChatIds.has(chatId)) {
      console.warn(`[bot] Rejected message from chat: ${chatId}`);
      return;
    }
    await next();
  });

  // HARD STOP — runs BEFORE PIN lock and BEFORE the per-chat queue so a
  // wedged loop or busy worker can never block it. Mobile-friendly aliases.
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim().toLowerCase();
    if (text === "/stop" || text === "/abort" || text === "/cancel" || text === "/kill") {
      const chatId = ctx.chat.id;
      const drained = drainQueue(chatId);
      const aborted = abortChat(chatId);
      const msg = (aborted || drained > 0)
        ? `⏹ Stopped. (in-flight aborted: ${aborted ? "yes" : "no"}, queued cleared: ${drained})`
        : "Nothing in flight.";
      await ctx.reply(msg).catch(() => {});
      return;
    }
    await next();
  });

  // PIN lock middleware
  if (isPinEnabled()) {
    bot.on("message:text", async (ctx, next) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text.trim();

      if (text.startsWith("/unlock ")) {
        const pin = text.slice("/unlock ".length).trim();
        const result = tryUnlock(chatId, pin);
        if (result.success) {
          await ctx.reply("\u{1F513} Unlocked. Session is active.");
        } else if (result.lockedOut) {
          await ctx.reply("\u{1F6AB} Too many failed attempts. Try again later.");
        } else {
          await ctx.reply("\u{274C} Invalid PIN.");
        }
        return;
      }

      if (text === "/lock") {
        lock(chatId);
        await ctx.reply("\u{1F512} Session locked. Use /unlock <pin> to resume.");
        return;
      }

      if (isLocked(chatId)) {
        await ctx.reply("\u{1F512} Session is locked. Use /unlock <pin> to unlock.");
        return;
      }

      touchActivity(chatId);
      await next();
    });
  }

  // Handle text messages — fast path for capture, agent path for everything else
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    // Fast path: explicit capture commands ($0, <1s)
    const cmd = isCaptureCommand(text);
    if (cmd) {
      const result = capture(cmd.type, cmd.payload);
      if (result.success) {
        await ctx.reply(`\u2713 Captured: ${result.line}`);
      } else {
        await ctx.reply(`\u2717 Capture failed: ${result.error}`);
      }
      return;
    }

    // Triage commands ($0, <1s)
    if (text === "/review") {
      await ctx.reply(getReviewSummary());
      return;
    }
    if (text.startsWith("/approve ")) {
      const n = Number(text.slice(9).trim());
      if (n) { await ctx.reply(triageApprove(n)); } else { await ctx.reply("Usage: /approve <n>"); }
      return;
    }
    if (text.startsWith("/discard ")) {
      const n = Number(text.slice(9).trim());
      if (n) { await ctx.reply(triageDiscard(n)); } else { await ctx.reply("Usage: /discard <n>"); }
      return;
    }
    if (text.startsWith("/view ")) {
      const n = Number(text.slice(6).trim());
      if (n) {
        await ctx.replyWithChatAction("typing").catch(() => {});
        const result = triageView(n);
        await sendSplitMessages(ctx, result);
      } else {
        await ctx.reply("Usage: /view <n>");
      }
      return;
    }

    // Project commands
    if (text === "/projects") {
      const dirs = refreshProjectDirs();
      const currentPath = getActiveProject(chatId);
      const currentName = currentPath ? path.basename(currentPath) : null;
      const list = dirs
        .map((d) => (d === currentName ? `• **${d}** (active)` : `• ${d}`))
        .join("\n");
      await ctx.reply(list || "No projects found in ~/projects/");
      return;
    }
    if (text.startsWith("/project ")) {
      const name = text.slice("/project ".length).trim();
      const dirs = getProjectDirs();
      const found = dirs.find((d) => d.toLowerCase() === name.toLowerCase());
      if (found) {
        const projectPath = path.join(PROJECTS_ROOT, found);
        setActiveProject(chatId, projectPath);
        await ctx.reply(`Switched to ${found}\ncwd: ${projectPath}`);
      } else {
        await ctx.reply(`Unknown project: ${name}\nUse /projects to see available.`);
      }
      return;
    }

    if (text === "/update") {
      await ctx.reply("\u{1F504} Starting self-upgrade. Bot will restart shortly...");
      const result = await triggerSelfUpgrade();
      if (!result.ok) {
        await ctx.reply(`✗ Failed to trigger updater (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
      }
      return;
    }

    // Memory commands
    if (text === "/memory" || text.startsWith("/memory ")) {
      const memories = getRecentMemories(chatId);
      const m = text.slice("/memory".length).trim().match(/^delete\s+(\d+)$/i);
      if (m) {
        const target = memories[Number(m[1]) - 1];
        if (!target) { await ctx.reply(`No memory at index ${m[1]}. Use /memory to list.`); return; }
        const ok = deleteMemoryById(chatId, target.id);
        await ctx.reply(ok ? `✓ Deleted: ${target.content}` : `✗ Delete failed.`);
        return;
      }
      if (memories.length === 0) { await ctx.reply("No memories stored yet."); return; }
      const list = memories.map((m, i) => `${i + 1}. ${m.content}`).join("\n");
      await ctx.reply(`Memories (${memories.length}):\n${list}\n\nUse /memory delete <n> to remove one.`);
      return;
    }
    if (text === "/forget") { await ctx.reply(`Cleared ${clearMemories(chatId)} memories.`); return; }
    if (text === "/help") { await ctx.reply(HELP_TEXT); return; }
    if (text === "/commands") { await ctx.reply(COMMANDS_TEXT); return; }

    // Session control — Claude-CLI-style equivalents on the bot side
    if (text === "/clear") {
      const cleared = clearSession(chatId, DEFAULT_AGENT_ID);
      await ctx.reply(cleared ? "✓ Session cleared. Next turn starts fresh." : "No active session to clear.");
      return;
    }
    if (text === "/context") {
      const sid = getSession(chatId, DEFAULT_AGENT_ID);
      const cwd = getActiveProject(chatId) ?? config.agentCwd;
      const mems = countMemories(chatId);
      const sidTail = sid ? sid.slice(-8) : "(none)";
      await ctx.reply(
        `📍 cwd: ${cwd}\n` +
        `🧵 session: ${sidTail}\n` +
        `🧠 memories: ${mems}\n` +
        `🤖 model: ${config.agentModel}`,
      );
      return;
    }

    // Agent path — PAI-aware, streaming
    enqueue(chatId, async () => {
      await handleMessageStreaming(ctx, chatId, text);
    });
  });

  // Handle voice messages — transcribe then route to agent
  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id;

    // PIN lock check for voice
    if (isPinEnabled() && isLocked(chatId)) {
      await ctx.reply("\u{1F512} Session is locked. Use /unlock <pin> to unlock.");
      return;
    }
    if (isPinEnabled()) touchActivity(chatId);

    // Check combo inside the queue so a preceding photo-download task stages it first.
    enqueue(chatId, async () => {
      const combo = takePhotoCombo(chatId);
      if (combo) {
        await handleVoiceComboWithPhoto(ctx, chatId, combo);
        return;
      }
      await handleVoiceMessage(ctx, chatId);
    });
  });

  // Handle photo messages — download then route to agent with file path
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id;

    // PIN lock check for photos
    if (isPinEnabled() && isLocked(chatId)) {
      await ctx.reply("\u{1F512} Session is locked. Use /unlock <pin> to unlock.");
      return;
    }
    if (isPinEnabled()) touchActivity(chatId);

    enqueue(chatId, async () => {
      await handlePhotoMessage(ctx, chatId);
    });
  });

  // Handle document messages — download then route to agent with file path
  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id;

    if (isPinEnabled() && isLocked(chatId)) {
      await ctx.reply("\u{1F512} Session is locked. Use /unlock <pin> to unlock.");
      return;
    }
    if (isPinEnabled()) touchActivity(chatId);

    enqueue(chatId, async () => {
      await handleDocumentMessage(ctx, chatId);
    });
  });

  // Reject other message types
  bot.on("message", async (ctx) => {
    if (!ctx.message.text && !ctx.message.voice && !ctx.message.photo && !ctx.message.document) {
      await ctx.reply("I can handle text, voice, photo, and document messages.");
    }
  });
  registerBotMenu(bot);
  return bot;
}

/** Handle text messages with streaming response to Telegram. */
export async function handleMessageStreaming(
  ctx: Context,
  chatId: number,
  text: string,
): Promise<void> {
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);
  await ctx.replyWithChatAction("typing").catch(() => {});

  let streamedMessageId: number | null = null;
  let buffer = "";
  let committedLength = 0; // chars already frozen in previous messages
  let lastFlush = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  async function flushBuffer() {
    if (!buffer) return;

    // Only work with the un-committed portion (chars not yet frozen)
    const currentSegment = buffer.slice(committedLength);
    if (!currentSegment) return;

    // Exfiltration guard on streamed content
    const scan = scanForSecrets(currentSegment);
    if (!scan.clean) {
      console.warn(`[exfiltration] Blocked streamed content for chat ${chatId}`);
      buffer = buffer.slice(0, committedLength) + "[Content redacted — contained sensitive data]";
      return;
    }

    // committedLength stays in raw-char space; we only transform what Telegram renders.
    const segmentDisplay = stripSentinelsForDisplay(currentSegment);
    if (!segmentDisplay.trim()) return;

    try {
      if (currentSegment.length > TELEGRAM_MAX_LENGTH && streamedMessageId) {
        const rawCut = findSafeSplitBoundary(currentSegment, TELEGRAM_MAX_LENGTH);
        const freezeRaw = currentSegment.slice(0, rawCut);
        const freezeDisplay = stripSentinelsForDisplay(freezeRaw).slice(0, TELEGRAM_MAX_LENGTH);
        if (!freezeDisplay) return;
        const edited = await ctx.api.editMessageText(chatId, streamedMessageId, freezeDisplay).catch(() => null);
        if (!edited) return;
        committedLength += freezeRaw.length;
        const overflowRaw = currentSegment.slice(rawCut);
        if (overflowRaw.length > 0) {
          const overflowDisplay = stripSentinelsForDisplay(overflowRaw).slice(0, TELEGRAM_MAX_LENGTH);
          if (overflowDisplay) {
            const sent = await ctx.reply(overflowDisplay);
            streamedMessageId = sent.message_id;
          }
        }
      } else if (streamedMessageId) {
        await ctx.api.editMessageText(chatId, streamedMessageId, segmentDisplay.slice(0, TELEGRAM_MAX_LENGTH)).catch(() => {});
      } else {
        const sent = await ctx.reply(segmentDisplay.slice(0, TELEGRAM_MAX_LENGTH));
        streamedMessageId = sent.message_id;
      }
    } catch {}
    lastFlush = Date.now();
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    const elapsed = Date.now() - lastFlush;
    const delay = Math.max(0, STREAM_DEBOUNCE_MS - elapsed);
    flushTimer = setTimeout(() => flushBuffer(), delay);
  }

  try {
    // Project intent detection — NL triggers project switch before agent spawn
    const detectedProject = detectProjectIntent(text);
    if (detectedProject) {
      const projectPath = path.join(PROJECTS_ROOT, detectedProject);
      setActiveProject(chatId, projectPath);
      // Notify user of implicit switch
      if (streamedMessageId) {
        await ctx.api.editMessageText(chatId, streamedMessageId, `→ ${detectedProject}`).catch(() => {});
      } else {
        const sent = await ctx.reply(`→ ${detectedProject}`);
        streamedMessageId = sent.message_id;
      }
    }

    // Resolve CWD: active project > env fallback
    const activeCwd = getActiveProject(chatId) ?? config.agentCwd;
    const existingSessionId = getSession(chatId, DEFAULT_AGENT_ID);

    // Memory search — embed query, find relevant context
    let memoryContext = "";
    const queryEmbedding = config.memoryEnabled ? await embedText(text).catch(() => null) : null;
    if (queryEmbedding) {
      const relevant = searchMemories(chatId, queryEmbedding);
      if (relevant.length > 0) {
        memoryContext = "[Memory context]\n" + relevant.map((m) => `- ${m.content}`).join("\n") + "\n\n";
      }
    }

    const agentMessage = memoryContext + text;

    const epochAtStart = getClearEpoch(chatId, DEFAULT_AGENT_ID);

    const result = await runAgentWithRetry({
      message: agentMessage,
      sessionId: existingSessionId,
      agentId: DEFAULT_AGENT_ID,
      cwd: activeCwd,
      chatId,
      onText: (chunk) => {
        buffer += chunk;
        // Only start streaming after minimum chars accumulated
        if (buffer.length >= STREAM_MIN_CHARS) {
          scheduleFlush();
        }
      },
    });

    // Final flush with cost footer
    if (flushTimer) clearTimeout(flushTimer);

    if (result.sessionId) {
      const persisted = upsertSessionIfEpochMatches(
        chatId,
        DEFAULT_AGENT_ID,
        result.sessionId,
        epochAtStart,
      );
      if (!persisted) {
        console.log(`[bot] /clear won race for chat ${chatId}; skipping session upsert`);
      }
    }

    const responseText = buffer || result.text || "(No response)";
    const footer = formatCostFooter(result);
    const fullResponse = `${responseText}\n\n${footer}`;

    // Final exfiltration check
    const scan = scanForSecrets(fullResponse);
    if (!scan.clean) {
      console.warn(`[exfiltration] Blocked final response for chat ${chatId}`);
      await ctx.reply(formatRedactionWarning(scan.matches));
      return;
    }

    // Slice against fullResponse (pre-strip) so committedLength stays consistent.
    const { paths: imagePaths } = extractAndValidateImages(fullResponse, activeCwd);
    const finalRaw = fullResponse.slice(committedLength);
    const { text: finalStripped } = extractAndValidateImages(finalRaw, activeCwd);
    const finalSegment = finalStripped.trim().length > 0 ? finalStripped : finalRaw;

    // Send/edit final message — split across messages if needed
    if (streamedMessageId) {
      if (finalSegment.length <= TELEGRAM_MAX_LENGTH) {
        await ctx.api.editMessageText(chatId, streamedMessageId, finalSegment).catch(() => {});
      } else {
        const chunks = splitMessage(finalSegment);
        await ctx.api.editMessageText(chatId, streamedMessageId, chunks[0]!).catch(() => {});
        for (let i = 1; i < chunks.length; i++) {
          await ctx.reply(chunks[i]!);
        }
      }
    } else {
      await sendSplitMessages(ctx, finalSegment);
    }

    for (const filepath of imagePaths) {
      await ctx.replyWithPhoto(new InputFile(filepath)).catch((e) => {
        console.warn("[bot] photo send failed", e);
      });
    }

    // Fire-and-forget memory extraction — never blocks response delivery
    if (config.memoryEnabled) extractAndStore(chatId, text, responseText);
  } catch (err) {
    if (flushTimer) clearTimeout(flushTimer);
    if (err instanceof AbortedError) {
      // User already saw "⏹ Stopped." — do not also send a "Failed" reply.
      console.log(`[bot] Aborted run for chat ${chatId}`);
    } else {
      console.error(`[bot] Failed to process message for chat ${chatId}:`, err);
      await ctx.reply("Failed to get a response. Please try again.").catch(() => {});
    }
  } finally {
    clearInterval(typingInterval);
  }
}

