/** SDK bridge — runAgent with streaming text chunks + model selection. */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.ts";

export interface AgentOptions {
  message: string;
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  maxTurns?: number;
  onText?: (chunk: string) => void;
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

  try {
    for await (const message of query({
      prompt: opts.message,
      options: {
        model: config.agentModel,
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
  } finally {
    clearTimeout(timeout);
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
