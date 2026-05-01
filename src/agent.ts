/** SDK bridge — runAgent with streaming text chunks + model selection. */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.ts";
import { RUNTIME_PROMPT } from "./runtime-prompt.ts";

export interface AgentOptions {
  message: string;
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  maxTurns?: number;
  onText?: (chunk: string) => void;
  /** Per-chat key — when set, the AbortController is registered so /stop can abort it. */
  chatId?: number;
}

/**
 * In-flight AbortController registry — one entry per chat with active runAgent.
 * Used by /stop on Telegram and by SIGTERM in index.ts to cancel before exit.
 * Only one entry per chatId at a time because queue.ts serializes per-chat tasks.
 */
const inflight = new Map<number, AbortController>();

/** Abort the in-flight runAgent for a chat. Returns true if one was aborted. */
export function abortChat(chatId: number): boolean {
  const c = inflight.get(chatId);
  if (!c) return false;
  c.abort();
  return true;
}

/** Abort every in-flight runAgent. Returns count aborted. */
export function abortAll(): number {
  let n = 0;
  for (const c of inflight.values()) {
    c.abort();
    n++;
  }
  return n;
}

/**
 * Sentinel thrown when runAgent is cancelled via AbortController (user /stop,
 * SIGTERM, or timeout). Distinct from generic SDK errors so the retry loop
 * can bail out instead of restarting the work the user just stopped.
 */
export class AbortedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AbortedError";
  }
}

export interface AgentResult {
  text: string | null;
  sessionId: string | undefined;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  let sessionId: string | undefined;
  let resultText: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.agentTimeoutMs);
  if (opts.chatId !== undefined) inflight.set(opts.chatId, controller);

  try {
    for await (const message of query({
      prompt: opts.message,
      options: {
        model: config.agentModel,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: RUNTIME_PROMPT,
        },
        permissionMode: "bypassPermissions" as const,
        allowDangerouslySkipPermissions: true,
        settingSources: ["user", "project"],
        maxTurns: opts.maxTurns ?? config.agentMaxTurns,
        cwd: opts.cwd ?? config.agentCwd,
        abortController: controller,
        ...(opts.sessionId ? { resume: opts.sessionId } : {}),
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }

      // Stream assistant text to callback
      if (message.type === "assistant" && opts.onText) {
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
              opts.onText(block.text);
            }
          }
        }
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          resultText = message.result;
        }
        inputTokens = message.usage.input_tokens;
        outputTokens = message.usage.output_tokens;
        costUsd = message.total_cost_usd;
        if (!sessionId) {
          sessionId = message.session_id;
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new AbortedError(`runAgent aborted (chat ${opts.chatId ?? "n/a"})`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (opts.chatId !== undefined) inflight.delete(opts.chatId);
  }

  return { text: resultText, sessionId, inputTokens, outputTokens, costUsd };
}

export async function runAgentWithRetry(
  opts: AgentOptions,
  maxRetries = 2,
): Promise<AgentResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runAgent(opts);
    } catch (err) {
      // Aborted runs (user /stop, SIGTERM, timeout) must NEVER retry —
      // otherwise the bot silently restarts work the user just stopped.
      if (err instanceof AbortedError) throw err;

      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[agent] Attempt ${attempt + 1}/${maxRetries + 1} failed:`,
        msg,
      );

      // If resume failed (stale session), retry without session ID
      if (opts.sessionId && attempt === 0) {
        console.log("[agent] Retrying without session resumption (stale session fallback)");
        opts = { ...opts, sessionId: undefined };
        continue;
      }

      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
