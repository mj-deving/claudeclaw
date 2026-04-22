/** Document downloads from Telegram → local disk, for agent Read-tool consumption. */

import type { Context } from "grammy";
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { handleMessageStreaming } from "./bot.ts";

const DOC_DIR = "/tmp/claudeclaw/docs";
const DOC_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DOC_BYTES = 20 * 1024 * 1024;

export interface DocumentDownloadResult {
  success: boolean;
  filepath: string;
  error?: string;
}

const MIME_EXT_MAP: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/xml": ".xml",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "text/xml": ".xml",
  "text/x-log": ".log",
  "text/x-python": ".py",
  "text/x-typescript": ".ts",
  "text/javascript": ".js",
  "text/html": ".html",
  "text/css": ".css",
};

function isAllowedMime(mime: string): boolean {
  if (!mime) return false;
  if (mime in MIME_EXT_MAP) return true;
  if (mime.startsWith("text/")) return true;
  return false;
}

function deriveExtension(fileName: string | undefined, mime: string): string {
  if (fileName) {
    const ext = path.extname(fileName);
    if (ext) return ext.toLowerCase();
  }
  if (mime in MIME_EXT_MAP) return MIME_EXT_MAP[mime]!;
  if (mime.startsWith("text/")) return ".txt";
  return ".bin";
}

export async function downloadTelegramDocument(
  _fileId: string,
  fileUrl: string,
  chatId: number,
  messageId: number,
  ext: string,
): Promise<DocumentDownloadResult> {
  if (!config.botToken) {
    return { success: false, filepath: "", error: "BOT_TOKEN not configured" };
  }

  try {
    if (!existsSync(DOC_DIR)) {
      mkdirSync(DOC_DIR, { recursive: true });
    }

    const resp = await fetch(fileUrl, { signal: AbortSignal.timeout(60000) });
    if (!resp.ok) {
      return { success: false, filepath: "", error: `Download failed: ${resp.status}` };
    }

    const buffer = await resp.arrayBuffer();
    const filename = `${chatId}-${messageId}-${Date.now()}${ext}`;
    const filepath = path.join(DOC_DIR, filename);

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

export async function handleDocumentMessage(ctx: Context, chatId: number): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc) return;

  const mime = doc.mime_type ?? "";
  const fileName = doc.file_name;
  const fileSize = doc.file_size ?? 0;

  if (!isAllowedMime(mime)) {
    await ctx.reply(`\u2717 Document type not allowed: ${mime || "unknown"}`);
    return;
  }

  if (fileSize > MAX_DOC_BYTES) {
    await ctx.reply(`\u2717 Document too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB (max 20 MB)`);
    return;
  }

  await ctx.replyWithChatAction("typing").catch(() => {});

  const file = await ctx.api.getFile(doc.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const ext = deriveExtension(fileName, mime);

  const result = await downloadTelegramDocument(
    doc.file_id,
    fileUrl,
    chatId,
    ctx.message!.message_id,
    ext,
  );
  if (!result.success) {
    await ctx.reply(`\u2717 Document download failed: ${result.error}`);
    return;
  }

  const caption = ctx.message?.caption?.trim() ?? "";
  const promptText = caption
    ? `[Document attached: ${result.filepath}]\n\n${caption}`
    : `[Document attached: ${result.filepath}]\n\nAnalyze this document.`;

  await handleMessageStreaming(ctx, chatId, promptText);
}

export function cleanupOldDocuments(): number {
  if (!existsSync(DOC_DIR)) return 0;
  const now = Date.now();
  let removed = 0;
  for (const name of readdirSync(DOC_DIR)) {
    const full = path.join(DOC_DIR, name);
    try {
      const stat = statSync(full);
      if (now - stat.mtimeMs > DOC_TTL_MS) {
        unlinkSync(full);
        removed++;
      }
    } catch {
      // Skip unreadable files
    }
  }
  return removed;
}
