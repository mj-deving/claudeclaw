/** Voice transcription via Groq Whisper — .oga from Telegram → text. */

import { config } from "./config.ts";

export interface TranscriptionResult {
  success: boolean;
  text: string;
  error?: string;
}

/**
 * Download a file from Telegram's API, then send it to Groq Whisper for transcription.
 * Telegram voice notes are .oga (Opus in OGG) — Groq accepts OGG natively.
 */
export async function transcribeVoice(fileUrl: string): Promise<TranscriptionResult> {
  if (!config.groqApiKey) {
    return { success: false, text: "", error: "GROQ_API_KEY not configured" };
  }

  try {
    // Download the voice file from Telegram
    const fileResp = await fetch(fileUrl, { signal: AbortSignal.timeout(30000) });
    if (!fileResp.ok) {
      return { success: false, text: "", error: `Failed to download voice: ${fileResp.status}` };
    }
    const audioBuffer = await fileResp.arrayBuffer();

    // Send to Groq Whisper
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.oga");
    formData.append("model", "whisper-large-v3-turbo");
    formData.append("response_format", "json");

    const groqResp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!groqResp.ok) {
      const errBody = await groqResp.text().catch(() => "");
      return { success: false, text: "", error: `Groq API error ${groqResp.status}: ${errBody.slice(0, 200)}` };
    }

    const result = await groqResp.json() as { text?: string };
    const text = result.text?.trim() ?? "";

    if (!text) {
      return { success: false, text: "", error: "Empty transcription" };
    }

    return { success: true, text };
  } catch (err) {
    return {
      success: false,
      text: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
