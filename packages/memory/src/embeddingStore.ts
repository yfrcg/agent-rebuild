import { getDb } from "../../storage/src/db";
import type { MemoryEmbeddingRecord } from "./types";

/**
 * 逐条遍历数据库中的所有 embedding 记录。
 *
 * 使用生成器而不是一次性 `SELECT *` 到内存，
 * 是为了在记忆量很大时仍然保持稳定内存占用。
 */
export function* iterateAllEmbeddingRecords(): IterableIterator<MemoryEmbeddingRecord> {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT chunkId, file_id, filePath, section, content, embedding
    FROM mem_embeddings
    ORDER BY filePath ASC, chunkId ASC
  `);

  for (const row of (stmt as any).iterate() as IterableIterator<any>) {
    yield {
      chunkId: row.chunkId,
      file_id: row.file_id,
      filePath: row.filePath,
      section: row.section,
      content: row.content,
      embedding: row.embedding ? (JSON.parse(row.embedding) as number[]) : undefined,
    };
  }
}

/**
 * 一次性读取全部 embedding 记录。
 *
 * 这个函数更方便旧逻辑和测试使用，
 * 但大数据量场景下仍应优先选择生成器版本。
 */
export function getAllEmbeddingRecords(): MemoryEmbeddingRecord[] {
  return [...iterateAllEmbeddingRecords()];
}

/**
 * 写入单条 embedding。
 */
export function saveEmbedding(chunkId: string, embedding: number[]) {
  const db = getDb();
  db.prepare(`
    UPDATE mem_embeddings
    SET embedding = ?
    WHERE chunkId = ?
  `).run(JSON.stringify(embedding), chunkId);
}

/**
 * 批量写入多条 embedding。
 *
 * 通过事务把多次 UPDATE 合并提交，可以显著减少磁盘 I/O 次数。
 */
export function saveEmbeddingsBatch(records: Array<{ chunkId: string; embedding: number[] }>) {
  if (records.length === 0) return;

  const db = getDb();
  db.exec("BEGIN TRANSACTION");
  try {
    const stmt = db.prepare(`
      UPDATE mem_embeddings
      SET embedding = ?
      WHERE chunkId = ?
    `);

    for (const record of records) {
      stmt.run(JSON.stringify(record.embedding), record.chunkId);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
