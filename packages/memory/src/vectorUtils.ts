/**
 * 计算两个向量的余弦相似度。
 *
 * 余弦相似度关注的是“方向是否接近”，而不是“长度是否相同”，
 * 因此非常适合比较 embedding 这类高维语义向量。
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
