/** Pure telegram message helpers — splitting for 4096-char limit, cost footer. */

import type { Context } from "grammy";
import type { AgentResult } from "./agent.ts";

export const TELEGRAM_MAX_LENGTH = 4096;

export function formatCostFooter(result: AgentResult): string {
  const cost = result.costUsd.toFixed(4);
  return `\u{1F4CA} In: ${result.inputTokens.toLocaleString()} | Out: ${result.outputTokens.toLocaleString()} | $${cost}`;
}

export function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) { chunks.push(remaining); break; }
    let splitIndex = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = TELEGRAM_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/, "");
  }
  return chunks;
}

export async function sendSplitMessages(ctx: Context, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}
