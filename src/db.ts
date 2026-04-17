/** SQLite session persistence with composite key (chat_id, agent_id). */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

const DB_PATH = path.join(config.agentCwd, ".claudeclaw", "sessions.db");

let db: Database;

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
      PRIMARY KEY (chat_id, agent_id)
    );
  `);
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

export function closeDb(): void {
  db?.close();
}
