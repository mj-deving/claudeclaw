/** Memory v2 — fact storage, semantic search, duplicate detection. */

import { db } from "./db.ts";

export interface Memory {
  id: number;
  chat_id: number;
  content: string;
  source: string;
  created_at: string;
  similarity?: number;
}

const EMBEDDING_BYTES = 384 * 4;

export function initMemoryDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      source TEXT NOT NULL DEFAULT 'extraction',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Back up condemned rows before DELETE so the dim-swap migration is reversible.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories_legacy_backup (
      id INTEGER,
      chat_id INTEGER,
      content TEXT,
      embedding BLOB,
      embedding_bytes INTEGER,
      source TEXT,
      created_at TEXT,
      backed_up_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const backed = db.run(
    `INSERT INTO memories_legacy_backup (id, chat_id, content, embedding, embedding_bytes, source, created_at)
     SELECT id, chat_id, content, embedding, length(embedding), source, created_at
     FROM memories WHERE length(embedding) != ?`,
    [EMBEDDING_BYTES],
  );
  const result = db.run("DELETE FROM memories WHERE length(embedding) != ?", [EMBEDDING_BYTES]);
  if (result.changes > 0) {
    console.log(
      `[memory] Migrated ${result.changes} legacy embedding row(s) to memories_legacy_backup (${backed.changes} backed up)`,
    );
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id'
    );
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
  `);
}

/** Store a memory with its embedding. Returns false if duplicate detected (>0.85 similarity). */
export function storeMemory(
  chatId: number,
  content: string,
  embedding: Float32Array,
  source: string = "extraction",
): boolean {
  // Duplicate detection — check existing memories for this chat
  const existing = getAllEmbeddings(chatId);
  for (const row of existing) {
    const sim = cosineSimilarity(embedding, row.embedding);
    if (sim > 0.85) {
      return false; // Duplicate — skip
    }
  }

  const embeddingBuf = Buffer.from(embedding.buffer);
  db.run(
    "INSERT INTO memories (chat_id, content, embedding, source) VALUES (?, ?, ?, ?)",
    [chatId, content, embeddingBuf, source],
  );
  return true;
}

/** Semantic search — returns memories above threshold, ranked by similarity. */
export function searchMemories(
  chatId: number,
  queryEmbedding: Float32Array,
  threshold: number = 0.3,
  limit: number = 10,
): Memory[] {
  const rows = db
    .query<{ id: number; chat_id: number; content: string; source: string; created_at: string; embedding: Buffer }, [number]>(
      "SELECT id, chat_id, content, source, created_at, embedding FROM memories WHERE chat_id = ?",
    )
    .all(chatId);

  const scored: Memory[] = [];
  for (const row of rows) {
    const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    const sim = cosineSimilarity(queryEmbedding, stored);
    if (sim >= threshold) {
      scored.push({
        id: row.id,
        chat_id: row.chat_id,
        content: row.content,
        source: row.source,
        created_at: row.created_at,
        similarity: sim,
      });
    }
  }

  return scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)).slice(0, limit);
}

/** Get recent memories for display (/memory command). */
export function getRecentMemories(chatId: number, limit: number = 20): Memory[] {
  return db
    .query<{ id: number; chat_id: number; content: string; source: string; created_at: string }, [number, number]>(
      "SELECT id, chat_id, content, source, created_at FROM memories WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(chatId, limit);
}

/** Clear all memories for a chat (/forget command). */
export function clearMemories(chatId: number): number {
  const result = db.run("DELETE FROM memories WHERE chat_id = ?", [chatId]);
  return result.changes;
}

/** Get all embeddings for a chat (used for dedup). */
function getAllEmbeddings(chatId: number): Array<{ id: number; embedding: Float32Array }> {
  const rows = db
    .query<{ id: number; embedding: Buffer }, [number]>(
      "SELECT id, embedding FROM memories WHERE chat_id = ?",
    )
    .all(chatId);

  return rows.map((row) => ({
    id: row.id,
    embedding: new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
  }));
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
