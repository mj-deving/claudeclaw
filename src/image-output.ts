/** Agent → Telegram image output: parse [TG_IMAGE: path] sentinels from agent responses. */

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const TG_IMAGE_OUT_DIR = "/tmp/claudeclaw/out";
const TG_IMAGE_REGEX = /\[TG_IMAGE:\s*([^\]\n]+)\]/g;
const TG_IMAGE_COMPLETE = /\[TG_IMAGE:\s*[^\]\n]+\]/g;
const TG_IMAGE_DANGLING = /\[TG_IMAGE:[^\]\n]*$/;
const TG_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const TG_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Strip complete sentinels AND any trailing unclosed sentinel that's still streaming. */
export function stripSentinelsForDisplay(text: string): string {
  return text.replace(TG_IMAGE_COMPLETE, "").replace(TG_IMAGE_DANGLING, "").replace(/\n{3,}/g, "\n\n");
}

/** Find a raw-char split point ≤ maxLen that does not land mid-sentinel. */
export function findSafeSplitBoundary(text: string, maxLen: number): number {
  if (text.length <= maxLen) return text.length;
  const slice = text.slice(0, maxLen);
  const dangling = slice.match(TG_IMAGE_DANGLING);
  if (!dangling) return maxLen;
  const safe = maxLen - dangling[0].length;
  return safe > 0 ? safe : maxLen;
}

export function ensureOutputDir(): void {
  if (!existsSync(TG_IMAGE_OUT_DIR)) {
    mkdirSync(TG_IMAGE_OUT_DIR, { recursive: true });
  }
}

export interface ExtractedImages {
  text: string;
  paths: string[];
}

export function extractAndValidateImages(text: string, activeCwd: string): ExtractedImages {
  const paths: string[] = [];
  const matches = Array.from(text.matchAll(TG_IMAGE_REGEX));
  let stripped = text;

  for (const match of matches) {
    stripped = stripped.replace(match[0], "");
    const raw = match[1]?.trim();
    if (!raw) continue;
    if (!path.isAbsolute(raw)) {
      console.warn(`[bot] TG_IMAGE rejected (not absolute): ${raw}`);
      continue;
    }
    // Canonicalize via realpath so symlinks cannot escape the allowlist.
    let resolved: string;
    try {
      resolved = realpathSync(path.resolve(raw));
    } catch {
      console.warn(`[bot] TG_IMAGE rejected (realpath failed): ${raw}`);
      continue;
    }
    const outDirReal = (() => {
      try { return realpathSync(TG_IMAGE_OUT_DIR); } catch { return TG_IMAGE_OUT_DIR; }
    })();
    const cwdReal = (() => {
      try { return realpathSync(path.resolve(activeCwd)); } catch { return path.resolve(activeCwd); }
    })();
    const inOutDir = resolved.startsWith(outDirReal + path.sep) || resolved === outDirReal;
    const inCwd = resolved.startsWith(cwdReal + path.sep);
    if (!inOutDir && !inCwd) {
      console.warn(`[bot] TG_IMAGE rejected (outside allowed dirs): ${resolved}`);
      continue;
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!TG_IMAGE_EXTS.has(ext)) {
      console.warn(`[bot] TG_IMAGE rejected (bad extension): ${resolved}`);
      continue;
    }
    try {
      const stat = statSync(resolved);
      if (stat.size > TG_IMAGE_MAX_BYTES) {
        console.warn(`[bot] TG_IMAGE rejected (too large ${stat.size}): ${resolved}`);
        continue;
      }
    } catch {
      console.warn(`[bot] TG_IMAGE rejected (stat failed): ${resolved}`);
      continue;
    }
    paths.push(resolved);
  }

  return { text: stripped.replace(/\n{3,}/g, "\n\n"), paths };
}
