/** Image downloads from Telegram → local disk, for agent Read-tool consumption. */

import type { Context } from "grammy";
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { handleMessageStreaming } from "./bot.ts";
import { enqueue } from "./queue.ts";

const IMAGE_DIR = "/tmp/claudeclaw/images";
const IMAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface AlbumBuffer {
  chatId: number;
  groupId: string;
  photos: string[];
  caption: string;
  ctx: Context;
  timer: ReturnType<typeof setTimeout>;
}

const ALBUM_BUFFERS = new Map<string, AlbumBuffer>();
const ALBUM_FLUSH_MS = 1500;

function albumKey(chatId: number, groupId: string): string {
  return `${chatId}:${groupId}`;
}

function flushAlbum(key: string): void {
  const entry = ALBUM_BUFFERS.get(key);
  if (!entry) return;
  ALBUM_BUFFERS.delete(key);

  enqueue(entry.chatId, async () => {
    const list = entry.photos.join(", ");
    const body = entry.caption || "Analyze these images.";
    const prompt = `[Images attached (${entry.photos.length}): ${list}]\n\n${body}`;
    await handleMessageStreaming(entry.ctx, entry.chatId, prompt);
  });
}

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
  const groupId = ctx.message?.media_group_id;

  await ctx.replyWithChatAction("typing").catch(() => {});

  const file = await ctx.api.getFile(largest.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

  const result = await downloadTelegramPhoto(largest.file_id, fileUrl, chatId, ctx.message!.message_id);
  if (!result.success) {
    await ctx.reply(`\u2717 Image download failed: ${result.error}`);
    return;
  }

  if (groupId) {
    const key = albumKey(chatId, groupId);
    const existing = ALBUM_BUFFERS.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.photos.push(result.filepath);
      existing.ctx = ctx;
      if (caption) existing.caption = caption;
      existing.timer = setTimeout(() => flushAlbum(key), ALBUM_FLUSH_MS);
    } else {
      const buf: AlbumBuffer = {
        chatId,
        groupId,
        photos: [result.filepath],
        caption,
        ctx,
        timer: setTimeout(() => flushAlbum(key), ALBUM_FLUSH_MS),
      };
      ALBUM_BUFFERS.set(key, buf);
    }
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
