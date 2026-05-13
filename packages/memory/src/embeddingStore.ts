/**
 * ?????CS336 ???
 * ???packages/memory/src/embeddingStore.ts
 * ??????????
 * ????????????FTS/?????????????
 * ???????????????????????????????????? README ????????????????
 */

import { getDb } from "../../storage/src/db";
import type { MemoryEmbeddingRecord } from "./types";

/**
 * Encode a number array as a Float64Array BLOB for compact binary storage.
 */
function embeddingToBlob(embedding: number[]): Buffer {
  const float64 = new Float64Array(embedding);
  return Buffer.from(float64.buffer);
}

/**
 * Decode a BLOB (or legacy JSON string) back to a number array.
 */
function blobToEmbedding(raw: unknown): number[] | undefined {
  if (!raw) return undefined;

  // Legacy JSON string format
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as number[];
    } catch {
      return undefined;
    }
  }

  // Binary BLOB format
  if (raw instanceof Buffer || raw instanceof Uint8Array) {
    const float64 = new Float64Array(raw.buffer, raw.byteOffset, raw.byteLength / 8);
    return Array.from(float64);
  }

  return undefined;
}

/**
 * 逐条遍历数据库中的所有 embedding 记录。
 *
 * 使用生成器而不是一次性 `SELECT *` 到内存，
 * 是为了在记忆量很大时仍然保持稳定内存占用。
 * Supports both legacy JSON TEXT and new Float64 BLOB formats.
 */
export function* iterateAllEmbeddingRecords(): IterableIterator<MemoryEmbeddingRecord> {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT chunkId, file_id, filePath, section, content, embedding
    FROM mem_embeddings
    ORDER BY filePath ASC, chunkId ASC
  `);

  for (const row of stmt.iterate()) {
    yield {
      chunkId: String(row.chunkId),
      file_id: String(row.file_id),
      filePath: String(row.filePath),
      section: String(row.section),
      content: String(row.content),
      embedding: blobToEmbedding(row.embedding),
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
 * 写入单条 embedding as BLOB.
 */
export function saveEmbedding(chunkId: string, embedding: number[]) {
  const db = getDb();
  db.prepare(`
    UPDATE mem_embeddings
    SET embedding = ?
    WHERE chunkId = ?
  `).run(embeddingToBlob(embedding), chunkId);
}

/**
 * 批量写入多条 embedding as BLOB.
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
      stmt.run(embeddingToBlob(record.embedding), record.chunkId);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Migrate all legacy JSON TEXT embeddings to Float64 BLOB format.
 * Returns the count of migrated records.
 */
export function migrateEmbeddingsToBlob(): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT chunkId, embedding FROM mem_embeddings
    WHERE embedding IS NOT NULL AND typeof(embedding) = 'text'
  `).all() as Array<{ chunkId: string; embedding: string }>;

  if (rows.length === 0) return 0;

  const stmt = db.prepare(`UPDATE mem_embeddings SET embedding = ? WHERE chunkId = ?`);
  const migrate = db.transaction(() => {
    for (const row of rows) {
      try {
        const numbers = JSON.parse(row.embedding) as number[];
        stmt.run(embeddingToBlob(numbers), row.chunkId);
      } catch {
        // Skip malformed entries
      }
    }
  });
  migrate();
  return rows.length;
}
