import { getAllEmbeddingRecords } from "./embeddingStore";
import { embedText } from "./embedder";
import { cosineSimilarity } from "./vectorUtils";
import type { MemorySearchResult } from "./types";

export async function vectorSearch(query: string, limit = 5): Promise<MemorySearchResult[]> {
  const queryEmbedding = await embedText(query);//把你搜索的词（比如“帮我找找昨天的报错”）发给大模型，大模型秒回一个包含 1024 个数字的数组（坐标）。
  const records = getAllEmbeddingRecords();//把 SQLite 数据库里存的所有记忆全部捞进内存里。

  const scored: MemorySearchResult[] = records
    .filter((record) => record.embedding && record.embedding.length > 0)//这些“没有坐标”的记忆踢出计算队列，防止后面算数学题时报错
    .map((record) => ({
      chunkId: record.chunkId,
      filePath: record.filePath,
      section: record.section,
      content: record.content,
      score: cosineSimilarity(queryEmbedding, record.embedding!),
      source: "vector" as const,
    }))//调用了 cosineSimilarity（余弦相似度），用你问题的 1024 维坐标，去和每一条记忆的 1024 维坐标算夹角
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);//根据算出的分数，从高到低排个序，然后干净利落地切出前 limit 名（默认前 5 名）

  return scored;
}