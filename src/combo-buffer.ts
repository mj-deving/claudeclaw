/** Photo + voice-caption combo buffer: waits briefly after a single photo for a voice note. */

import type { Context } from "grammy";
import { enqueue } from "./queue.ts";
import { handleMessageStreaming } from "./bot.ts";
import { transcribeVoice } from "./voice.ts";
import { config } from "./config.ts";

export interface PhotoCombo {
  filepath: string;
  caption: string;
  ctx: Context;
  chatId: number;
  timer: ReturnType<typeof setTimeout>;
}

const PHOTO_COMBO: Map<number, PhotoCombo> = new Map();
export const COMBO_WINDOW_MS = 2500;

function fireCombo(entry: PhotoCombo): void {
  enqueue(entry.chatId, async () => {
    const body = entry.caption || "Analyze this image.";
    const prompt = `[Image attached: ${entry.filepath}]\n\n${body}`;
    await handleMessageStreaming(entry.ctx, entry.chatId, prompt);
  });
}

/** Stage a single-photo combo; a subsequent voice within the window becomes its caption. */
export function stagePhotoCombo(chatId: number, filepath: string, caption: string, ctx: Context): void {
  const existing = PHOTO_COMBO.get(chatId);
  if (existing) {
    clearTimeout(existing.timer);
    PHOTO_COMBO.delete(chatId);
    fireCombo(existing);
  }

  const entry: PhotoCombo = {
    filepath,
    caption,
    ctx,
    chatId,
    timer: setTimeout(() => {
      const self = PHOTO_COMBO.get(chatId);
      if (!self) return;
      PHOTO_COMBO.delete(chatId);
      fireCombo(self);
    }, COMBO_WINDOW_MS),
  };
  PHOTO_COMBO.set(chatId, entry);
}

/** Pop a pending photo for this chat if one is waiting. Cancels the timer. */
export function takePhotoCombo(chatId: number): PhotoCombo | null {
  const entry = PHOTO_COMBO.get(chatId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  PHOTO_COMBO.delete(chatId);
  return entry;
}

/** Handle a voice message when a photo combo is pending. Transcribes and routes combined. */
export async function handleVoiceComboWithPhoto(
  ctx: Context,
  chatId: number,
  combo: PhotoCombo,
): Promise<void> {
  const voice = ctx.message?.voice;
  if (!voice) return;
  await ctx.reply("\u{1F399}\uFE0F + \u{1F5BC}\uFE0F Combining voice with photo...");
  const file = await ctx.api.getFile(voice.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const transcription = await transcribeVoice(fileUrl);
  if (!transcription.success) {
    await ctx.reply(`\u2717 Transcription failed: ${transcription.error}`);
    enqueue(chatId, async () => {
      const body = combo.caption || "Analyze this image.";
      await handleMessageStreaming(ctx, chatId, `[Image attached: ${combo.filepath}]\n\n${body}`);
    });
    return;
  }
  enqueue(chatId, async () => {
    await handleMessageStreaming(
      ctx,
      chatId,
      `[Image attached: ${combo.filepath}]\n\n${transcription.text}`,
    );
  });
}
