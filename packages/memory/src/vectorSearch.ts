import { iterateAllEmbeddingRecords } from "./embeddingStore";//使用生成器迭代器，避免一次性加载全量数据到内存
import { embedText } from "./embedder";//调用 DashScope API 把搜索词变成 1024 维向量
import { cosineSimilarity } from "./vectorUtils";//计算两个向量的余弦相似度
import type { MemorySearchResult } from "./types";//搜索结果类型定义

export async function vectorSearch(query: string, limit = 5): Promise<MemorySearchResult[]> {
  const queryEmbedding = await embedText(query);//把搜索词变成向量

  //只维护长度为 limit 的 Top-K 数组，内存占用恒定（不受总记录数影响）
  const topK: MemorySearchResult[] = [];

  //用迭代器一条一条从数据库抽数据，避免全量加载到内存
  for (const record of iterateAllEmbeddingRecords()) {
    if (!record.embedding || record.embedding.length === 0) continue;//跳过还没生成向量的 chunks

    const score = cosineSimilarity(queryEmbedding, record.embedding);//算这条记忆和查询词的相似度

    //只有比当前 topK 最低分高，或者还没满，才有可能挤进来
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

      //重新按降序排列
      topK.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      //永远保持数组长度不超过 limit，多余的扔掉
      if (topK.length > limit) {
        topK.pop();
      }
    }
  }

  return topK;
}
