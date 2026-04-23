/** Telegram Menu button commands + /help text (dynamic skill list via pf). */

import type { Bot } from "grammy";
import { spawnSync } from "node:child_process";

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
  { command: "clear", description: "Drop SDK session — fresh next turn" },
  { command: "context", description: "Show cwd, session, memories, model" },
  { command: "commands", description: "List bot-side commands by category" },
  { command: "help", description: "Show all commands and skills" },
];

export async function registerBotMenu(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(BOT_COMMANDS).catch((err) => {
    console.warn("[bot] setMyCommands failed:", err instanceof Error ? err.message : err);
  });
}

interface Skill { name: string; description: string }

function scanSkills(): Skill[] {
  // Delegate to PAI's authoritative discovery CLI — single source of truth
  // across filesystem skills AND plugin-provided skills.
  try {
    const proc = spawnSync("pf", ["list", "skills", "--json"], { encoding: "utf8", timeout: 5000 });
    if (proc.status !== 0 || !proc.stdout) return [];
    const parsed = JSON.parse(proc.stdout) as Array<{ name?: unknown; description?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    const skills: Skill[] = [];
    for (const row of parsed) {
      if (typeof row.name !== "string" || typeof row.description !== "string") continue;
      const firstSentence = row.description.split(/(?<=[.!?])\s/)[0] ?? row.description;
      skills.push({ name: row.name, description: firstSentence.slice(0, 120) });
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
  "/clear — drop SDK session (fresh start, keeps memory)",
  "/context — show cwd, session, memories, model",
  "/commands — list bot-side commands by category",
  "/lock /unlock <pin> — session lock",
  "/update — self-upgrade bot",
  "/help — this list",
  "",
].join("\n");

export const COMMANDS_TEXT = [
  "🤖 BOT COMMANDS BY CATEGORY",
  "",
  "📝 CAPTURE",
  "/add <text> — idea to INBOX",
  "/url <url> — save URL to INBOX",
  "/memo <text> — save memo to INBOX",
  "/remind <text> — schedule reminder",
  "",
  "📋 TRIAGE",
  "/review — show review queue",
  "/approve <n> — approve item n",
  "/discard <n> — discard item n",
  "/view <n> — preview item n",
  "",
  "📂 PROJECT",
  "/projects — list available projects",
  "/project <name> — switch active project",
  "",
  "🧠 MEMORY",
  "/memory — list stored memories",
  "/memory delete <n> — remove one",
  "/forget — wipe all memory",
  "",
  "🧵 SESSION (Claude-CLI-style)",
  "/clear — drop SDK session, fresh next turn",
  "/context — cwd, session, memories, model",
  "",
  "🔒 SECURITY",
  "/lock — lock session",
  "/unlock <pin> — unlock with PIN",
  "",
  "🛠 SYSTEM",
  "/update — self-upgrade bot",
  "/help — full command + skill list",
  "/commands — this list",
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
