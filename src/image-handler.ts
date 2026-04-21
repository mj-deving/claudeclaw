/** Image downloads from Telegram → local disk, for agent Read-tool consumption. */

import type { Context } from "grammy";
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { handleMessageStreaming } from "./bot.ts";

const IMAGE_DIR = "/tmp/claudeclaw/images";
const IMAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ImageDownloadResult {
  success: boolean;
  filepath: string;
  error?: string;
}

/**
 * Download a Telegram photo to local disk and return the absolute path.
 * The agent will use its built-in Read tool (which supports images) to analyze it.
 */
export async function downloadTelegramPhoto(
  fileId: string,
  fileUrl: string,
  chatId: number,
  messageId: number,
): Promise<ImageDownloadResult> {
  if (!config.botToken) {
    return { success: false, filepath: "", error: "BOT_TOKEN not configured" };
  }

  try {
    if (!existsSync(IMAGE_DIR)) {
      mkdirSync(IMAGE_DIR, { recursive: true });
    }

    const resp = await fetch(fileUrl, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) {
      return { success: false, filepath: "", error: `Download failed: ${resp.status}` };
    }

    const buffer = await resp.arrayBuffer();
    const ext = path.extname(fileUrl).split("?")[0] || ".jpg";
    const filename = `${chatId}-${messageId}-${Date.now()}${ext}`;
    const filepath = path.join(IMAGE_DIR, filename);

    writeFileSync(filepath, Buffer.from(buffer));
    return { success: true, filepath };
  } catch (err) {
    return {
      success: false,
      filepath: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Handle photo messages — download then route to agent with file path in prompt. */
export async function handlePhotoMessage(ctx: Context, chatId: number): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return;

  // Telegram sends multiple resolutions — pick the highest
  const largest = photos[photos.length - 1]!;
  const caption = ctx.message?.caption?.trim() ?? "";

  await ctx.replyWithChatAction("typing").catch(() => {});

  const file = await ctx.api.getFile(largest.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

  const result = await downloadTelegramPhoto(largest.file_id, fileUrl, chatId, ctx.message!.message_id);
  if (!result.success) {
    await ctx.reply(`\u2717 Image download failed: ${result.error}`);
    return;
  }

  const promptText = caption
    ? `[Image attached: ${result.filepath}]\n\n${caption}`
    : `[Image attached: ${result.filepath}]\n\nAnalyze this image.`;

  await handleMessageStreaming(ctx, chatId, promptText);
}

/** Delete images older than TTL. Safe to call on startup or periodically. */
export function cleanupOldImages(): number {
  if (!existsSync(IMAGE_DIR)) return 0;
  const now = Date.now();
  let removed = 0;
  for (const name of readdirSync(IMAGE_DIR)) {
    const full = path.join(IMAGE_DIR, name);
    try {
      const stat = statSync(full);
      if (now - stat.mtimeMs > IMAGE_TTL_MS) {
        unlinkSync(full);
        removed++;
      }
    } catch {
      // Skip unreadable files
    }
  }
  return removed;
}
