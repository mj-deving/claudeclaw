/** Telegram Menu button commands + /help text listing bot commands and PAI skills. */

import type { Bot } from "grammy";

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

export const HELP_TEXT = [
  "*Bot commands*",
  "/add · /url · /memo · /remind — capture to INBOX",
  "/review · /approve · /discard · /view — triage review queue",
  "/projects · /project <name> — switch working project",
  "/memory — list memories  |  /memory delete <n> — remove one",
  "/forget — wipe all memory (nuclear)",
  "/lock · /unlock <pin> — session lock",
  "/update — self-upgrade bot",
  "",
  "*Claude skills* (talk naturally; these route automatically)",
  "PAI core: Pai · Telos · Agents · Thinking",
  "Content: ContentAnalysis · Research · Scraping · Investigation",
  "Dev: Gsd · TDD · CodeReview · GitWorkflow · Troubleshooting · Documentation",
  "Visuals: Media · Frontend · VisualExplainer · ScientificDeck",
  "Data: Data · DEMOS",
  "Ops: Security · Utilities",
  "",
  "Say what you want — the router picks the skill.",
].join("\n");
