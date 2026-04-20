/** Fast-path capture — classify + store to IDEAS.md without spinning up an agent. */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

const INBOX_FILE = join(
  process.env.HOME ?? "/home/mj",
  ".claude/PAI/USER/TELOS/INBOX.md",
);

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
