/**
 * ?????CS336 ???
 * ???packages/memory/src/backfillEmbeddings.ts
 * ??????????
 * ????????????FTS/?????????????
 * ???????????????????????????????????? README ????????????????
 */

import { getDb } from "../../storage/src/db";
import { embedText } from "./embedder";
import { saveEmbeddingsBatch } from "./embeddingStore";
import { getPendingEmbeddingFiles, markEmbeddingReady, markEmbeddingError } from "./fileManager";

/**
 * 每个批次并发处理的 chunk 数量。
 *
 * 这个值越大，吞吐越高；
 * 但也越容易撞上外部 embedding API 的限流。
 */
const BATCH_SIZE = 5;

/**
 * 为所有待处理文件回填 embedding。
 *
 * 处理流程是：
 * 1. 找出 embedding_status 为 pending 的文件。
 * 2. 逐文件查出尚未生成向量的 chunk。
 * 3. 分批并发调用 embedding API。
 * 4. 成功结果批量写回数据库。
 * 5. 全部完成后将文件标记为 ready，失败则标记为 error。
 */
export async function backfillEmbeddings() {
  const db = getDb();
  const pendingFiles = getPendingEmbeddingFiles(db);

  if (pendingFiles.length === 0) {
    return { total: 0, updated: 0, pendingFiles: 0, message: "nothing to backfill" };
  }

  let totalUpdated = 0;

  for (const file of pendingFiles) {
    const missing = db.prepare(`
      SELECT chunkId, content FROM mem_embeddings
      WHERE file_id = ? AND (embedding IS NULL OR embedding = '')
    `).all(file.file_id) as Array<{ chunkId: string; content: string }>;

    if (missing.length === 0) {
      markEmbeddingReady(db, file.file_id);
      continue;
    }

    let fileUpdated = 0;
    let hasError = false;

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (record) => {
          const embedding = await embedText(record.content);
          return { chunkId: record.chunkId, embedding };
        })
      );

      const successfulBatch: Array<{ chunkId: string; embedding: number[] }> = [];
      let batchHasFailure = false;

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          successfulBatch.push(result.value);
          fileUpdated += 1;
        } else {
          console.error(`Embedding failed for chunk ${batch[j].chunkId}:`, result.reason);
          batchHasFailure = true;
        }
      }

      if (successfulBatch.length > 0) {
        saveEmbeddingsBatch(successfulBatch);
      }

      if (batchHasFailure) {
        markEmbeddingError(db, file.file_id);
        hasError = true;
        break;
      }
    }

    totalUpdated += fileUpdated;

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
