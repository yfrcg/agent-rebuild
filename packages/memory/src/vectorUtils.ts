/*
在所有花哨的 AI 概念（大模型、RAG、Agent）之下，
最底层的基石其实就是这段只有二十几行的初中/高中数学公式。
这就是大名鼎鼎的**余弦相似度（Cosine Similarity）**算法。
*/
export function cosineSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}