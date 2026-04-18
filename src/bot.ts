/** Grammy bot setup with allowlist, PIN lock, exfiltration guard, typing indicator, message splitting, cost footer. */

import { Bot, type Context, GrammyError } from "grammy";
import { config } from "./config.ts";
import { getSession, upsertSession } from "./db.ts";
import { enqueue } from "./queue.ts";
import { runAgentWithRetry, type AgentResult } from "./agent.ts";
import { isLocked, tryUnlock, lock, touchActivity, isPinEnabled } from "./security.ts";
import { scanForSecrets, formatRedactionWarning } from "./exfiltration-guard.ts";

const TELEGRAM_MAX_LENGTH = 4096;
const DEFAULT_AGENT_ID = "main";

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

  // PIN lock middleware — runs after allowlist, handles /unlock and /lock,
  // blocks all other messages when locked
  if (isPinEnabled()) {
    bot.on("message:text", async (ctx, next) => {
      const chatId = ctx.chat.id;
      const text = ctx.message.text.trim();

      // /unlock <pin> — always allowed, even when locked
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

      // /lock — manual lock (only meaningful when unlocked)
      if (text === "/lock") {
        lock(chatId);
        await ctx.reply("\u{1F512} Session locked. Use /unlock <pin> to resume.");
        return;
      }

      // Block all other messages when locked
      if (isLocked(chatId)) {
        await ctx.reply("\u{1F512} Session is locked. Use /unlock <pin> to unlock.");
        return;
      }

      // Unlocked — reset idle timer and continue
      touchActivity(chatId);
      await next();
    });
  }

  // Handle text messages
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    enqueue(chatId, async () => {
      await handleMessage(ctx, chatId, text);
    });
  });

  bot.on("message", async (ctx) => {
    if (!ctx.message.text) {
      await ctx.reply("I can only process text messages.");
    }
  });

  return bot;
}

async function handleMessage(
  ctx: Context,
  chatId: number,
  text: string,
): Promise<void> {
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);
  await ctx.replyWithChatAction("typing").catch(() => {});

  try {
    // Look up existing session for resumption
    const existingSessionId = getSession(chatId, DEFAULT_AGENT_ID);

    const result = await runAgentWithRetry({
      message: text,
      sessionId: existingSessionId,
      agentId: DEFAULT_AGENT_ID,
    });

    // Persist the session ID for future resumption
    if (result.sessionId) {
      upsertSession(chatId, DEFAULT_AGENT_ID, result.sessionId);
    }

    // Format response with cost footer
    const responseText = result.text ?? "(No response from Claude)";
    const footer = formatCostFooter(result);
    const fullResponse = `${responseText}\n\n${footer}`;

    // Exfiltration guard — scan for leaked secrets before sending
    const scan = scanForSecrets(fullResponse);
    if (!scan.clean) {
      console.warn(`[exfiltration] Blocked response for chat ${chatId}: ${scan.matches.join(", ")}`);
      await ctx.reply(formatRedactionWarning(scan.matches));
      return;
    }

    // Split and send
    await sendSplitMessages(ctx, fullResponse);
  } catch (err) {
    console.error(`[bot] Failed to process message for chat ${chatId}:`, err);
    await ctx.reply(
      "Failed to get a response. Please try again.",
    ).catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}

function formatCostFooter(result: AgentResult): string {
  const cost = result.costUsd.toFixed(4);
  return `\u{1F4CA} In: ${result.inputTokens.toLocaleString()} | Out: ${result.outputTokens.toLocaleString()} | $${cost}`;
}

/**
 * Split a message into chunks that fit within Telegram's 4096 char limit.
 * Tries to split at newlines to avoid breaking markdown.
 */
async function sendSplitMessages(
  ctx: Context,
  text: string,
): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline before the limit
    let splitIndex = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (splitIndex <= 0) {
      // No newline found, split at a space
      splitIndex = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
    }
    if (splitIndex <= 0) {
      // No space found, hard split
      splitIndex = TELEGRAM_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/, "");
  }

  return chunks;
}
