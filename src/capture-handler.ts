/** Fast-path capture + triage bridge — write to INBOX.md, read from REVIEW.md. */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

const HOME = process.env.HOME ?? "/home/mj";
const INBOX_FILE = join(HOME, ".claude/PAI/USER/TELOS/INBOX.md");
const REVIEW_FILE = join(HOME, ".claude/PAI/USER/TELOS/REVIEW.md");

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function detectTag(text: string): string {
  if (/^https?:\/\//.test(text.trim())) return "[URL] ";
  if (text.length > 80) return "[MEMO] ";
  return "";
}

export type CaptureType = "add" | "url" | "memo" | "remind";

export interface CaptureResult {
  success: boolean;
  line: string;
  error?: string;
}

export function capture(type: CaptureType, payload: string): CaptureResult {
  try {
    const dir = dirname(INBOX_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let line: string;
    if (type === "remind") {
      const byDate = new Date();
      byDate.setDate(byDate.getDate() + 7);
      const by = byDate.toISOString().split("T")[0];
      line = `- [${today()}] [REMIND by:${by}] ${payload}`;
    } else {
      const tag =
        type === "url"
          ? "[URL] "
          : type === "memo"
            ? "[MEMO] "
            : detectTag(payload);
      line = `- [${today()}] ${tag}${payload}`;
    }

    appendFileSync(INBOX_FILE, line + "\n");
    return { success: true, line };
  } catch (err) {
    return {
      success: false,
      line: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Read pending review items from REVIEW.md — returns formatted text for Telegram. */
export function getReviewSummary(): string {
  if (!existsSync(REVIEW_FILE)) return "Review queue is empty. Run mx daemon to process INBOX.";
  const content = readFileSync(REVIEW_FILE, "utf-8");
  const blocks = [...content.matchAll(/^### \[(\d+)\] \[(\w+)\] (.+)$/gm)];
  if (blocks.length === 0) return "Review queue is empty.";

  const lines = blocks.map(m => {
    const num = m[1] ?? "?";
    const cls = m[2] ?? "?";
    const title = m[3] ?? "untitled";
    const blockStart = content.indexOf(m[0]);
    const blockText = content.slice(blockStart, blockStart + 500);
    const suggested = blockText.match(/\*\*Suggested:\*\*\s*(\w+)/);
    return `${num}. [${cls}] ${title.slice(0, 50)}\n   → ${suggested?.[1] ?? "?"}`;
  });

  return `${blocks.length} items pending:\n\n${lines.join("\n\n")}\n\n/approve <n> or /discard <n>`;
}

/** Execute approve via mx CLI. */
export function triageApprove(n: number): string {
  try {
    const { execSync } = require("child_process");
    const out = execSync(`bun ${join(HOME, ".claude/tools/mx.ts")} approve ${n}`, {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    return out || `Approved item ${n}`;
  } catch (err) {
    return `Failed to approve: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Execute discard via mx CLI. */
export function triageDiscard(n: number): string {
  try {
    const { execSync } = require("child_process");
    const out = execSync(`bun ${join(HOME, ".claude/tools/mx.ts")} discard ${n}`, {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    return out || `Discarded item ${n}`;
  } catch (err) {
    return `Failed to discard: ${err instanceof Error ? err.message : String(err)}`;
  }
}
