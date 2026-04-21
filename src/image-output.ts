/** Agent → Telegram image output: parse [TG_IMAGE: path] sentinels from agent responses. */

import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const TG_IMAGE_OUT_DIR = "/tmp/claudeclaw/out";
const TG_IMAGE_REGEX = /\[TG_IMAGE:\s*([^\]\n]+)\]/g;
const TG_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const TG_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

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
    const resolved = path.resolve(raw);
    const inOutDir = resolved.startsWith(TG_IMAGE_OUT_DIR + path.sep) || resolved === TG_IMAGE_OUT_DIR;
    const inCwd = resolved.startsWith(path.resolve(activeCwd) + path.sep);
    if (!inOutDir && !inCwd) {
      console.warn(`[bot] TG_IMAGE rejected (outside allowed dirs): ${resolved}`);
      continue;
    }
    if (!existsSync(resolved)) {
      console.warn(`[bot] TG_IMAGE rejected (does not exist): ${resolved}`);
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
