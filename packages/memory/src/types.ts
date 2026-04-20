//原始记忆切片
export type MemoryChunk = {
  chunkId: string;
  filePath: string;
  section: string;
  content: string;
};
//可计算记忆：“有些记忆还没来得及生成向量”的中间状态
export type MemoryEmbeddingRecord = MemoryChunk & {
  embedding?: number[];
};
//最终形态：检索结果反馈
export type MemorySearchResult = MemoryChunk & {
  score?: number;
  source?: "fts" | "vector" | "hybrid";
};