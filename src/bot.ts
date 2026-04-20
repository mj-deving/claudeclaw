/** Grammy bot — allowlist, PIN lock, exfiltration guard, streaming responses, voice transcription. */

import { Bot, type Context } from "grammy";
import { config } from "./config.ts";
import { getSession, upsertSession, getActiveProject, setActiveProject } from "./db.ts";
import { enqueue } from "./queue.ts";
import { runAgentWithRetry, type AgentResult } from "./agent.ts";
import { isLocked, tryUnlock, lock, touchActivity, isPinEnabled } from "./security.ts";
import { scanForSecrets, formatRedactionWarning } from "./exfiltration-guard.ts";
import { capture, type CaptureType, getReviewSummary, triageApprove, triageDiscard } from "./capture-handler.ts";
import { transcribeVoice } from "./voice.ts";
import { searchMemories, getRecentMemories, clearMemories } from "./memory.ts";
import { embedText, extractAndStore } from "./extraction.ts";

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const TELEGRAM_MAX_LENGTH = 4096;
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

    // Memory commands
    if (text === "/memory") {
      const memories = getRecentMemories(chatId);
      if (memories.length === 0) {
        await ctx.reply("No memories stored yet.");
      } else {
        const list = memories.map((m) => `• ${m.content}`).join("\n");
        await ctx.reply(`Memories (${memories.length}):\n${list}`);
      }
      return;
    }
    if (text === "/forget") {
      const count = clearMemories(chatId);
      await ctx.reply(`Cleared ${count} memories.`);
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

    enqueue(chatId, async () => {
      await handleVoiceMessage(ctx, chatId);
    });
  });

  // Reject other message types
  bot.on("message", async (ctx) => {
    if (!ctx.message.text && !ctx.message.voice) {
      await ctx.reply("I can handle text and voice messages.");
    }
  });

  return bot;
}

/** Handle text messages with streaming response to Telegram. */
async function handleMessageStreaming(
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
  let lastFlush = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  async function flushBuffer() {
    if (!buffer) return;
    const text = buffer;

    // Exfiltration guard on streamed content
    const scan = scanForSecrets(text);
    if (!scan.clean) {
      console.warn(`[exfiltration] Blocked streamed content for chat ${chatId}`);
      buffer = "[Content redacted — contained sensitive data]";
    }

    try {
      if (streamedMessageId) {
        // Edit existing message with accumulated text
        const truncated = text.length > TELEGRAM_MAX_LENGTH
          ? text.slice(0, TELEGRAM_MAX_LENGTH - 20) + "\n\n[truncated]"
          : text;
        await ctx.api.editMessageText(chatId, streamedMessageId, truncated).catch(() => {});
      } else {
        // Send first message
        const truncated = text.length > TELEGRAM_MAX_LENGTH
          ? text.slice(0, TELEGRAM_MAX_LENGTH - 20) + "\n\n[truncated]"
          : text;
        const sent = await ctx.reply(truncated);
        streamedMessageId = sent.message_id;
      }
    } catch {
      // Edit can fail if message hasn't changed — ignore
    }
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
    const queryEmbedding = await embedText(text).catch(() => null);
    if (queryEmbedding) {
      const relevant = searchMemories(chatId, queryEmbedding);
      if (relevant.length > 0) {
        memoryContext = "[Memory context]\n" + relevant.map((m) => `- ${m.content}`).join("\n") + "\n\n";
      }
    }

    const agentMessage = memoryContext + text;

    const result = await runAgentWithRetry({
      message: agentMessage,
      sessionId: existingSessionId,
      agentId: DEFAULT_AGENT_ID,
      cwd: activeCwd,
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
      upsertSession(chatId, DEFAULT_AGENT_ID, result.sessionId);
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

    // Send/edit final message
    if (streamedMessageId) {
      const truncated = fullResponse.length > TELEGRAM_MAX_LENGTH
        ? fullResponse.slice(0, TELEGRAM_MAX_LENGTH - 20) + "\n\n[truncated]"
        : fullResponse;
      await ctx.api.editMessageText(chatId, streamedMessageId, truncated).catch(() => {});
    } else {
      await sendSplitMessages(ctx, fullResponse);
    }

    // Fire-and-forget memory extraction — never blocks response delivery
    extractAndStore(chatId, text, responseText);
  } catch (err) {
    console.error(`[bot] Failed to process message for chat ${chatId}:`, err);
    if (flushTimer) clearTimeout(flushTimer);
    await ctx.reply("Failed to get a response. Please try again.").catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}

/** Handle voice messages — transcribe via Groq Whisper, then route to agent. */
async function handleVoiceMessage(
  ctx: Context,
  chatId: number,
): Promise<void> {
  const voice = ctx.message?.voice;
  if (!voice) return;

  await ctx.replyWithChatAction("typing").catch(() => {});

  // Get file URL from Telegram
  const file = await ctx.api.getFile(voice.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

  // Transcribe
  const duration = voice.duration;
  await ctx.reply(`\u{1F399}\uFE0F Transcribing ${duration}s voice note...`);

  const transcription = await transcribeVoice(fileUrl);
  if (!transcription.success) {
    await ctx.reply(`\u2717 Transcription failed: ${transcription.error}`);
    return;
  }

  // Show transcription
  const preview = transcription.text.length > 200
    ? transcription.text.slice(0, 200) + "..."
    : transcription.text;
  await ctx.reply(`\u{1F399}\uFE0F Transcribed:\n${preview}\n\nProcessing...`);

  // Route transcribed text through the agent (PAI-aware)
  await handleMessageStreaming(ctx, chatId, transcription.text);
}

function formatCostFooter(result: AgentResult): string {
  const cost = result.costUsd.toFixed(4);
  return `\u{1F4CA} In: ${result.inputTokens.toLocaleString()} | Out: ${result.outputTokens.toLocaleString()} | $${cost}`;
}

async function sendSplitMessages(ctx: Context, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) { chunks.push(remaining); break; }
    let splitIndex = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = TELEGRAM_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/, "");
  }
  return chunks;
}
