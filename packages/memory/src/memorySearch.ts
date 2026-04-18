import { getDb } from "../../storage/src/db";
import type { SearchHit } from "../../core/src/types";

export function memorySearch(query: string, limit = 5): SearchHit[] {
  const db = getDb();

  try {
    const ftsStmt = db.prepare(`
      SELECT chunkId, filePath, section, content
      FROM mem_fts
      WHERE mem_fts MATCH ?
      LIMIT ?
    `);

    const ftsHits = ftsStmt.all(query, limit) as SearchHit[];
    if (ftsHits.length > 0) {
      return ftsHits;
    }
  } catch {
    // FTS 查询语法不合法时，自动降级到 LIKE 检索
  }

  const likeStmt = db.prepare(`
    SELECT chunkId, filePath, section, content
    FROM mem_docs
    WHERE content LIKE ?
    ORDER BY filePath ASC
    LIMIT ?
  `);

  return likeStmt.all(`%${query}%`, limit) as SearchHit[];
}