
import { iterateAllEmbeddingRecords } from "./embeddingStore";
import { embedText } from "./embedder";
import { cosineSimilarity } from "./vectorUtils";
import type { MemorySearchResult } from "./types";

/**
 * 执行基于向量相似度的语义检索。
 *
 * 流程是：
 * 1. 先把查询词转成 embedding。
 * 2. 遍历所有已生成向量的记忆 chunk。
 * 3. 计算余弦相似度。
 * 4. 仅保留得分最高的 Top-K 结果。
 */
export async function vectorSearch(query: string, limit = 5): Promise<MemorySearchResult[]> {
  const queryEmbedding = await embedText(query);
  const topK: MemorySearchResult[] = [];

  for (const record of iterateAllEmbeddingRecords()) {
    if (!record.embedding || record.embedding.length === 0) continue;

    const score = cosineSimilarity(queryEmbedding, record.embedding);

    const lowestScore = topK.length > 0 ? (topK[topK.length - 1].score ?? -1) : -1;
    if (topK.length < limit || score > lowestScore) {
      topK.push({
        chunkId: record.chunkId,
        file_id: record.file_id,
        filePath: record.filePath,
        section: record.section,
        content: record.content,
        score,
        source: "vector" as const,
      });

      topK.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      if (topK.length > limit) {
        topK.pop();
      }
    }
  }

  return topK;
}
