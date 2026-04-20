/*
在所有花哨的 AI 概念（大模型、RAG、Agent）之下，
最底层的基石其实就是这段只有二十几行的初中/高中数学公式。
这就是大名鼎鼎的**余弦相似度（Cosine Similarity）**算法。
*/

/**
 * 计算两个等长实数向量的余弦相似度。
 *
 * 余弦相似度衡量的是两个向量在方向上的接近程度，取值范围为 [-1, 1]：
 *   1.0  表示方向完全相同（两向量共线且同向）
 *   0.0  表示两向量正交（无相关性）
 *  -1.0  表示方向完全相反
 *
 * 与欧氏距离不同，余弦相似度对向量的幅度（长度）不敏感，
 * 只关注方向，因此特别适合比较文档嵌入、词向量等高维语义表示。
 *
 * 计算公式：
 *   cosine_similarity(A, B) = (A · B) / (||A|| * ||B||)
 * 其中：
 *   A · B  = Σ(a_i * b_i)  （向量点积，各维度分量相乘后求和）
 *   ||A||  = √(Σ(a_i²))   （向量的 L2 范数，即欧氏长度）
 *
 * @param a - 第一个向量（number[]），长度必须与 b 相等且非空
 * @param b - 第二个向量（number[]），长度必须与 a 相等且非空
 * @returns number - 余弦相似度，范围 [-1, 1]。若输入向量长度不一致或为空则返回 0
 */
export function cosineSimilarity(a: number[], b: number[]) {
  // 防御性校验：两向量长度必须相等且非空，否则无法计算
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  // 累加器：分别累积点积（dot）、向量A模平方（normA）、向量B模平方（normB）
  let dot = 0;
  let normA = 0;
  let normB = 0;

  // 遍历所有维度，累加分量乘积和各自平方和
  // 时间复杂度 O(n)，n 为向量维度（通常为 256/512/1024/1536）
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];      // 点积：a_i * b_i 累加
    normA += a[i] * a[i];    // 向量A模平方：A_i² 累加
    normB += b[i] * b[i];    // 向量B模平方：B_i² 累加
  }

  // 防止除零错误（零向量与任何向量相似度均为 0）
  if (normA === 0 || normB === 0) {
    return 0;
  }

  // 余弦相似度 = 点积 / (||A|| * ||B||)
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}