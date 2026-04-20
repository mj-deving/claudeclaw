/** Gemini-powered fact extraction and embedding. Fire-and-forget, never blocks. */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./config.ts";
import { storeMemory } from "./memory.ts";

let genai: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI | null {
  if (!config.geminiApiKey) return null;
  if (!genai) {
    genai = new GoogleGenerativeAI(config.geminiApiKey);
  }
  return genai;
}

/** Embed text into 768-dim vector via text-embedding-004. */
export async function embedText(text: string): Promise<Float32Array | null> {
  const client = getClient();
  if (!client) return null;

  const model = client.getGenerativeModel({ model: "text-embedding-004" });
  const result = await model.embedContent(text);
  const values = result.embedding.values;
  return new Float32Array(values);
}

/** Extract atomic facts from a conversation turn via Gemini Flash. */
async function extractFacts(userMsg: string, agentResponse: string): Promise<string[]> {
  const client = getClient();
  if (!client) return [];

  const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
  const prompt = [
    "Extract key facts from this conversation that would be useful to remember for future conversations.",
    "Return ONLY a JSON array of short, atomic fact strings. No explanation, no markdown — just the JSON array.",
    "If there are no memorable facts (greetings, small talk, routine acknowledgments), return an empty array [].",
    "",
    "User: " + userMsg,
    "",
    "Assistant: " + agentResponse.slice(0, 2000),
  ].join("\n");

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Parse JSON array from response — handle markdown code fences
  const cleaned = text.replace(/^```json?\s*/, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item: unknown): item is string => typeof item === "string");
}

/**
 * Fire-and-forget: extract facts from conversation, embed each, store if unique.
 * Call this AFTER sending the response — it never blocks the user.
 */
export function extractAndStore(chatId: number, userMsg: string, agentResponse: string): void {
  if (!config.geminiApiKey) return;

  // Fire and forget — don't await
  doExtraction(chatId, userMsg, agentResponse).catch((err) => {
    console.error("[memory] Extraction failed:", err instanceof Error ? err.message : err);
  });
}

async function doExtraction(chatId: number, userMsg: string, agentResponse: string): Promise<void> {
  const facts = await extractFacts(userMsg, agentResponse);
  if (facts.length === 0) return;

  for (const fact of facts) {
    const embedding = await embedText(fact);
    if (!embedding) continue;
    storeMemory(chatId, fact, embedding);
  }

  console.log(`[memory] Stored ${facts.length} fact(s) for chat ${chatId}`);
}
