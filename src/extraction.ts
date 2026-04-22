/** Fact extraction via Groq Llama 4 + local BGE embeddings. Fire-and-forget, never blocks. */

import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { config } from "./config.ts";
import { storeMemory } from "./memory.ts";

const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
const GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;

function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    embedderPromise = (pipeline("feature-extraction", EMBED_MODEL) as Promise<FeatureExtractionPipeline>)
      .catch((err) => {
        embedderPromise = null;
        throw err;
      });
  }
  return embedderPromise;
}

/** Pre-load the embedding model — fire-and-forget from boot to warm the cache. */
export function warmEmbedder(): void {
  getEmbedder().catch((err) => {
    console.error("[memory] Embedder warmup failed:", err instanceof Error ? err.message : err);
  });
}

/** Embed text into 384-dim vector via local BGE-small-en-v1.5 (mean-pooled, normalized). */
export async function embedText(text: string): Promise<Float32Array | null> {
  const embed = await getEmbedder();
  const output = await embed(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data as Float32Array);
}

/** Skip trivial messages that aren't worth an extraction LLM call. */
function isTrivial(text: string): boolean {
  const t = text.trim();
  if (t.length < 20) return true;
  if (/^\/\w+/.test(t)) return true;
  if (/^(hi|hello|hey|thanks|thx|ok|okay|yes|no|sure|cool|nice)\b[\s!.?]*$/i.test(t)) return true;
  return false;
}

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function extractFacts(userMsg: string, agentResponse: string): Promise<string[]> {
  if (isTrivial(userMsg)) return [];
  if (!config.groqApiKey) return [];

  const resp = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content:
            'Extract atomic facts worth remembering from the conversation. Return JSON: {"facts": [string, ...]}. Each fact is a short standalone statement. Return {"facts": []} for greetings, acknowledgments, or routine exchanges with nothing memorable.',
        },
        {
          role: "user",
          content: `User: ${userMsg}\nAssistant: ${agentResponse.slice(0, 2000)}`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Groq ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as GroqResponse;
  const text = data.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(text);
  const facts = parsed.facts;
  if (!Array.isArray(facts)) return [];
  return facts.filter((f: unknown): f is string => typeof f === "string" && f.trim().length > 0);
}

/**
 * Fire-and-forget: extract facts from conversation, embed each, store if unique.
 * Call this AFTER sending the response — it never blocks the user.
 */
export function extractAndStore(chatId: number, userMsg: string, agentResponse: string): void {
  if (!config.groqApiKey) return;

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
