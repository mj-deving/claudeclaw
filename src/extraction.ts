/** Claude + Voyage-powered fact extraction and embedding. Fire-and-forget, never blocks. */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import { storeMemory } from "./memory.ts";

let anthropic: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  if (!config.anthropicApiKey) return null;
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return anthropic;
}

/** Embed text into 512-dim vector via Voyage AI voyage-3-lite. */
export async function embedText(text: string): Promise<Float32Array | null> {
  if (!config.voyageApiKey) return null;

  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.voyageApiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model: "voyage-3-lite",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Voyage API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  const values = data.data[0]?.embedding;
  if (!values) return null;
  return new Float32Array(values);
}

/** Extract atomic facts from a conversation turn via Claude Haiku. */
async function extractFacts(userMsg: string, agentResponse: string): Promise<string[]> {
  const client = getAnthropicClient();
  if (!client) return [];

  const prompt = [
    "Extract key facts from this conversation that would be useful to remember for future conversations.",
    "Return ONLY a JSON array of short, atomic fact strings. No explanation, no markdown — just the JSON array.",
    "If there are no memorable facts (greetings, small talk, routine acknowledgments), return an empty array [].",
    "",
    "User: " + userMsg,
    "",
    "Assistant: " + agentResponse.slice(0, 2000),
  ].join("\n");

  const result = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const block = result.content[0];
  if (!block || block.type !== "text") return [];
  const text = block.text.trim();

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
  if (!config.anthropicApiKey || !config.voyageApiKey) return;

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
