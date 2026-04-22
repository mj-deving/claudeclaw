/** Telegram Menu button commands + /help text (dynamic skill list). */

import type { Bot } from "grammy";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "add", description: "Capture idea to INBOX" },
  { command: "url", description: "Save URL to INBOX" },
  { command: "memo", description: "Save memo to INBOX" },
  { command: "remind", description: "Schedule reminder" },
  { command: "review", description: "Show review queue" },
  { command: "approve", description: "Approve review item n" },
  { command: "discard", description: "Discard review item n" },
  { command: "view", description: "Preview review item n" },
  { command: "projects", description: "List available projects" },
  { command: "project", description: "Switch to project" },
  { command: "memory", description: "List stored memories" },
  { command: "forget", description: "Wipe all stored memory" },
  { command: "update", description: "Self-upgrade the bot" },
  { command: "lock", description: "Lock session" },
  { command: "unlock", description: "Unlock with PIN" },
  { command: "help", description: "Show all commands and skills" },
];

export async function registerBotMenu(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(BOT_COMMANDS).catch((err) => {
    console.warn("[bot] setMyCommands failed:", err instanceof Error ? err.message : err);
  });
}

interface Skill { name: string; description: string }

function parseFrontmatterDescription(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  // Search the full frontmatter block INCLUDING the closing \n--- so the
  // regex terminator always has something to match on.
  const fm = text.slice(0, end + 4);
  const match = fm.match(/^description:\s*([\s\S]+?)(?:\n[a-z_]+:|\n---)/m);
  const captured = match?.[1];
  if (!captured) return null;
  return captured.replace(/\s+/g, " ").trim();
}

function scanSkills(): Skill[] {
  const skillsDir = path.join(process.env.HOME ?? "", ".claude/skills");
  try {
    const entries = readdirSync(skillsDir);
    const skills: Skill[] = [];
    for (const name of entries) {
      const skillPath = path.join(skillsDir, name);
      try {
        if (!statSync(skillPath).isDirectory()) continue;
        const md = readFileSync(path.join(skillPath, "SKILL.md"), "utf8");
        const desc = parseFrontmatterDescription(md);
        if (!desc) continue;
        const firstSentence = desc.split(/(?<=[.!?])\s/)[0] ?? desc;
        skills.push({ name, description: firstSentence.slice(0, 120) });
      } catch { /* skip unreadable skill dirs */ }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

const BOT_HELP = [
  "🎛 BOT COMMANDS",
  "/add /url /memo /remind — capture to INBOX",
  "/review /approve <n> /discard <n> /view <n> — triage queue",
  "/projects /project <name> — switch working project",
  "/memory — list · /memory delete <n> — remove one",
  "/forget — wipe all memory (nuclear)",
  "/lock /unlock <pin> — session lock",
  "/update — self-upgrade bot",
  "/help — this list",
  "",
].join("\n");

function buildHelpText(): string {
  const skills = scanSkills();
  const skillLines = skills.length > 0
    ? skills.map((s) => `• ${s.name} — ${s.description}`).join("\n")
    : "(no skills found at ~/.claude/skills/)";
  return [
    BOT_HELP,
    `🧠 CLAUDE SKILLS (${skills.length})`,
    skillLines,
    "",
    "💡 Say what you want — the router picks the skill.",
  ].join("\n");
}

export const HELP_TEXT = buildHelpText();
