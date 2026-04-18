import Database from "better-sqlite3";
import { ensureDir, resolveWorkspacePath } from "../../core/src/config";

export function getDb() {
  ensureDir(resolveWorkspacePath("index"));
  const dbPath = resolveWorkspacePath("index", "memory.sqlite");
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_docs (
      chunkId TEXT PRIMARY KEY,
      filePath TEXT NOT NULL,
      section TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
      chunkId,
      filePath,
      section,
      content
    );
  `);

  return db;
}