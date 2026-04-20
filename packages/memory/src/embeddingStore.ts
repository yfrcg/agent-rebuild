/**
 * embeddingStore.ts
 *
 * 本模块负责向量（embedding）数据的持久化存储与批量读写操作。
 * 向量数据存储在 mem_embeddings 表中，每条记录关联一个 chunkId。
 *
 * 设计考量：
 * - 使用生成器（Generator）迭代器逐行读取，避免将数万甚至数十万条 chunk 一次性加载到内存
 * - 使用批量写入配合事务，减少频繁单条 UPDATE 带来的磁盘 I/O 开销
 */

import { getDb } from "../../storage/src/db";
import type { MemoryEmbeddingRecord } from "./types";

/**
 * 使用生成器模式遍历所有 embedding 记录。
 *
 * 生成器迭代器逐行吐出数据，不一次性加载全量到内存，
 * 可有效避免 Node.js V8 heap 在记忆库有几十万条 chunk 时爆掉的问题。
 *
 * @returns 一个可迭代对象，每次迭代返回一条 MemoryEmbeddingRecord
 */
export function* iterateAllEmbeddingRecords(): IterableIterator<MemoryEmbeddingRecord> {
  const db = getDb();

  // 按 filePath 和 chunkId 有序遍历，保证同一文件的 chunk 相邻，便于下游处理
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
      // embedding 字段在数据库中存储为 JSON 字符串，反序列化后得到 number[]
      embedding: row.embedding ? (JSON.parse(row.embedding) as number[]) : undefined,
    };
  }
}

/**
 * 全量加载所有 embedding 记录（兼容性保留，内部逻辑和 tests 仍在使用）。
 * 注意：大数据量场景请使用 iterateAllEmbeddingRecords() 避免内存溢出。
 *
 * @returns 所有 embedding 记录的数组
 */
export function getAllEmbeddingRecords(): MemoryEmbeddingRecord[] {
  return [...iterateAllEmbeddingRecords()];
}

/**
 * 单条写入（backfillEmbeddings 早期返回时仍用）。
 * 直接在 mem_embeddings 表中更新指定 chunkId 的向量数据。
 *
 * @param chunkId - 要更新的 chunk 唯一标识
 * @param embedding - 该 chunk 对应的向量数据（number[]）
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
 * 批量写入多个 chunk 的向量数据。
 *
 * 在事务内一次性提交多个 chunk 的向量更新，避免频繁单条 UPDATE 带来的磁盘 I/O 开销。
 * 配合 backfillEmbeddings 的并发批次使用，每批次结束后调用一次即可。
 *
 * @param records - 要批量更新的记录数组，每条包含 chunkId 和对应的向量数据
 */
export function saveEmbeddingsBatch(records: Array<{ chunkId: string; embedding: number[] }>) {
  // 空数组直接返回，避免无意义的空事务
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
    // 任何一条失败则回滚整批，保持数据一致性
    db.exec("ROLLBACK");
    throw e;
  }
}
