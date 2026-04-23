/** SQLite session persistence with composite key (chat_id, agent_id). */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

const DB_PATH = path.join(config.agentCwd, ".claudeclaw", "sessions.db");

export let db: Database;

export function initDb(): void {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      active_project TEXT,
      PRIMARY KEY (chat_id, agent_id)
    );
  `);

  // Migrate existing DBs — idempotent (SQLite errors if column already exists)
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN active_project TEXT");
  } catch {
    // Column already exists — expected on subsequent runs
  }
}

export function getSession(
  chatId: number,
  agentId: string,
): string | undefined {
  const row = db
    .query<{ session_id: string }, [number, string]>(
      "SELECT session_id FROM sessions WHERE chat_id = ? AND agent_id = ?",
    )
    .get(chatId, agentId);
  return row?.session_id;
}

export function upsertSession(
  chatId: number,
  agentId: string,
  sessionId: string,
): void {
  db.run(
    `INSERT INTO sessions (chat_id, agent_id, session_id)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id, agent_id) DO UPDATE SET
       session_id = excluded.session_id,
       updated_at = datetime('now')`,
    [chatId, agentId, sessionId],
  );
}

export function getActiveProject(chatId: number): string | undefined {
  const row = db
    .query<{ active_project: string | null }, [number]>(
      "SELECT active_project FROM sessions WHERE chat_id = ? AND active_project IS NOT NULL LIMIT 1",
    )
    .get(chatId);
  return row?.active_project ?? undefined;
}

// In-memory clear epoch — bumped by /clear so an in-flight agent call's
// post-completion upsert can detect "the user cleared while I was running"
// and skip persisting its new session_id.
const clearEpochs = new Map<string, number>();
const epochKey = (chatId: number, agentId: string) => `${chatId}:${agentId}`;

export function getClearEpoch(chatId: number, agentId: string): number {
  return clearEpochs.get(epochKey(chatId, agentId)) ?? 0;
}

export function clearSession(chatId: number, agentId: string): boolean {
  const k = epochKey(chatId, agentId);
  clearEpochs.set(k, (clearEpochs.get(k) ?? 0) + 1);
  const result = db.run(
    "UPDATE sessions SET session_id = '', updated_at = datetime('now') WHERE chat_id = ? AND agent_id = ?",
    [chatId, agentId],
  );
  return result.changes > 0;
}

/** Upsert only if no /clear ran since the caller captured the epoch. */
export function upsertSessionIfEpochMatches(
  chatId: number,
  agentId: string,
  sessionId: string,
  expectedEpoch: number,
): boolean {
  if (getClearEpoch(chatId, agentId) !== expectedEpoch) return false;
  upsertSession(chatId, agentId, sessionId);
  return true;
}

export function setActiveProject(chatId: number, projectPath: string): void {
  // Upsert: if a session row exists for this chat, update it; otherwise insert a placeholder
  const existing = db
    .query<{ chat_id: number }, [number]>(
      "SELECT chat_id FROM sessions WHERE chat_id = ? LIMIT 1",
    )
    .get(chatId);

  if (existing) {
    db.run(
      "UPDATE sessions SET active_project = ?, updated_at = datetime('now') WHERE chat_id = ?",
      [projectPath, chatId],
    );
  } else {
    db.run(
      `INSERT INTO sessions (chat_id, agent_id, session_id, active_project)
       VALUES (?, 'main', '', ?)`,
      [chatId, projectPath],
    );
  }
}

export function closeDb(): void {
  db?.close();
}
