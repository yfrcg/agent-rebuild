import { getDb } from "../../storage/src/db";
import { embedText } from "./embedder";
import { saveEmbeddingsBatch } from "./embeddingStore";
import { getPendingEmbeddingFiles, markEmbeddingReady, markEmbeddingError } from "./fileManager";

// 每个批次并发处理的 chunk 数量，可根据 API 速率限制调整（DashScope 如果有限流建议设为 2-3）
const BATCH_SIZE = 5;

export async function backfillEmbeddings() {
  const db = getDb();
  const pendingFiles = getPendingEmbeddingFiles(db);

  if (pendingFiles.length === 0) {
    return { total: 0, updated: 0, pendingFiles: 0, message: "nothing to backfill" };
  }

  let totalUpdated = 0;

  for (const file of pendingFiles) {
    // 只查这个文件缺失向量的 chunks，用 SQL 条件在数据库层过滤（避免全表扫描）
    const missing = db.prepare(`
      SELECT chunkId, content FROM mem_embeddings
      WHERE file_id = ? AND (embedding IS NULL OR embedding = '')
    `).all(file.file_id) as Array<{ chunkId: string; content: string }>;

    // 该文件所有 chunks 已有向量，直接标记 ready
    if (missing.length === 0) {
      markEmbeddingReady(db, file.file_id);
      continue;
    }

    let fileUpdated = 0;
    let hasError = false;

    // 按批次并发处理 missing chunks
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);

      // 这一批次内逐个调用，任意一个失败不会导致整个批次被丢弃（保留已成功的）
      const results = await Promise.allSettled(
        batch.map(async (record) => {
          const embedding = await embedText(record.content);
          return { chunkId: record.chunkId, embedding };
        })
      );

      // 批次内逐个检查结果，成功则收集，失败则记录
      const successfulBatch: Array<{ chunkId: string; embedding: number[] }> = [];
      let batchHasFailure = false;
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          successfulBatch.push(result.value);
          fileUpdated += 1;
        } else {
          // 批次内单个失败：记录错误但不中断整批
          console.error(`Embedding failed for chunk ${batch[j].chunkId}:`, result.reason);
          batchHasFailure = true;
        }
      }

      // 批次全部成功后，一次性批量写入数据库（减少 I/O 次数）
      if (successfulBatch.length > 0) {
        saveEmbeddingsBatch(successfulBatch);
      }

      // 批次内任意一个 chunk 失败，标记该文件为 error，停止后续批次处理
      if (batchHasFailure) {
        markEmbeddingError(db, file.file_id);
        hasError = true;
        break;
      }
    }

    // 把已成功处理的 chunks 累加到 total（无论是否有错误，已成功的不应丢失）
    totalUpdated += fileUpdated;

    // 只有在没发生错误且全部完成的情况下，才标记该文件为 ready
    if (!hasError && fileUpdated === missing.length) {
      markEmbeddingReady(db, file.file_id);
    }
  }

  const pendingAfter = getPendingEmbeddingFiles(db);

  return {
    total: totalUpdated,
    updated: totalUpdated,
    pendingFiles: pendingAfter.length,
    message: pendingAfter.length === 0 ? "all embeddings ready" : "some files still pending",
  };
}
