/**
 * hybridSearch.ts
 *
 * 混合检索模块：同时结合全文检索（FTS）和向量检索（vector search）的结果，
 * 使用 RRF（Reciprocal Rank Fusion，倒数排名融合）算法对两个结果集进行排序融合。
 *
 * 设计考量：
 * - FTS 使用 SQLite FTS5 全文索引，支持快速关键词匹配
 * - 向量检索使用 embedding 模型计算语义相似度
 * - RRF 算法完全抛弃绝对分数，仅依赖排名进行融合，对两种检索方式的分数尺度差异不敏感
 */

import { getDb } from "../../storage/src/db";
import { vectorSearch } from "./vectorSearch";
import type { MemorySearchResult } from "./types";

/**
 * RRF（倒数排名融合）分数计算公式。
 * 完全抛弃绝对分数，只看排名：score = Σ 1/(rank + k)
 *
 * 原理：某条记录在多个检索结果中的排名越靠前，融合分数越高。
 * k=60 是惯例经验值，作用是平滑排名差异，避免第1名和第2名的分差被过度放大。
 *
 * @param rank - 该条记录在某一结果集中的排名（从0开始）
 * @param k - 平滑因子，默认60
 * @returns RRF 融合分数
 */
function rrfScore(rank: number, k = 60) {
  return 1 / (rank + k);
}

/**
 * 混合检索入口函数。
 *
 * 同时执行 FTS 全文检索和向量语义检索，对两个结果集使用 RRF 算法融合排序，
 * 返回最相关的 limit 条记忆记录。
 *
 * @param query - 用户查询字符串
 * @param limit - 返回结果数量上限，默认为5
 * @returns 按融合分数降序排列的记忆检索结果数组
 */
export async function hybridSearch(query: string, limit = 5): Promise<MemorySearchResult[]> {
  const db = getDb();

  /**
   * 辅助函数：从 chunkId 查 mem_docs 补充 file_id。
   *
   * 背景：FTS 表（mem_fts）没有 file_id 字段，但向量表（mem_embeddings）有。
   * 为统一返回格式，需要从 mem_docs 中根据 chunkId 关联查询得到 file_id。
   *
   * @param hits - FTS 检索结果数组（缺少 file_id）
   * @returns 补充了 file_id 字段的检索结果数组
   */
  function enrichFileId(hits: MemorySearchResult[]): MemorySearchResult[] {
    if (hits.length === 0) return hits;

    // 批量查询，避免 N+1 查询问题
    const chunkIds = hits.map((h) => h.chunkId);
    const placeholders = chunkIds.map(() => "?").join(",");
    const rows = db.prepare(`SELECT chunkId, file_id FROM mem_docs WHERE chunkId IN (${placeholders})`).all(...chunkIds) as Array<{ chunkId: string; file_id: string }>;
    // 构建 chunkId -> file_id 的映射表
    const fileIdMap = new Map(rows.map((r) => [r.chunkId, r.file_id]));
    return hits.map((h) => ({ ...h, file_id: fileIdMap.get(h.chunkId) ?? "" }));
  }

  // ============================================================
  // 第一路：FTS 全文检索（中文支持有限，结果为 0 时用 LIKE 兜底）
  // ============================================================
  let ftsHits: MemorySearchResult[] = [];
  try {
    const ftsStmt = db.prepare(`
      SELECT chunkId, filePath, section, content
      FROM mem_fts
      WHERE content MATCH ?
      LIMIT ?
    `);

    // 对查询字符串进行转义处理，防止 FTS MATCH 语法错误
    const rows = ftsStmt.all(`"${query.replace(/"/g, '\\"')}"`, limit) as Array<{
      chunkId: string;
      filePath: string;
      section: string;
      content: string;
    }>;

    // 为每条 FTS 结果分配 RRF 分数（FTS 排名即为其在结果数组中的索引）
    ftsHits = rows.map((row, idx) => ({
      ...row,
      file_id: "",
      score: rrfScore(idx),
      source: "fts" as const,
    })) as MemorySearchResult[];
  } catch {
    // FTS 匹配失败（如查询语法错误、索引不存在等），降级为空数组
    ftsHits = [];
  }

  // ============================================================
  // FTS 中文失效时的兜底方案：使用 LIKE 模糊匹配
  // ============================================================
  if (ftsHits.length === 0) {
    const likeStmt = db.prepare(`
      SELECT chunkId, filePath, section, content
      FROM mem_docs
      WHERE content LIKE '%' || ? || '%'
      LIMIT ?
    `);
    const rows = likeStmt.all(query, limit) as Array<{
      chunkId: string;
      filePath: string;
      section: string;
      content: string;
    }>;
    // 同样分配 RRF 分数，保持与 FTS 路径的一致性
    ftsHits = rows.map((row, idx) => ({
      ...row,
      file_id: "",
      score: rrfScore(idx),
      source: "fts" as const,
    })) as MemorySearchResult[];
  }

  // 补充 file_id（FTS 表没有这字段，需要从 mem_docs 关联查询）
  ftsHits = enrichFileId(ftsHits);

  // ============================================================
  // 第二路：向量语义检索（结果已包含 file_id，来自 mem_embeddings 表）
  // ============================================================
  const vectorHits = (await vectorSearch(query, limit)).map((hit, idx) => ({
    ...hit,
    // 如果 vectorSearch 未返回分数，则使用 RRF 分数作为兜底
    score: hit.score ?? rrfScore(idx),
    source: "vector" as const,
  }));

  // ============================================================
  // 混合检索：RRF 分数累加融合
  // ============================================================
  // 使用 Map 按 chunkId 合并两路结果，同一 chunk 的分数累加
  const merged = new Map<string, MemorySearchResult>();

  // 首先将 FTS 结果放入合并集合
  for (const hit of ftsHits) {
    merged.set(hit.chunkId, {
      ...hit,
      source: "fts",
    });
  }

  // 然后将向量结果与 FTS 结果进行融合
  for (const hit of vectorHits) {
    const existing = merged.get(hit.chunkId);

    if (existing) {
      // 该 chunk 同时出现在两路检索结果中，RRF 分数累加，标记为 hybrid
      merged.set(hit.chunkId, {
        ...existing,
        score: (existing.score ?? 0) + (hit.score ?? 0),
        source: "hybrid",
      });
    } else {
      // 该 chunk 仅出现在向量检索结果中，标记为 vector
      merged.set(hit.chunkId, {
        ...hit,
        source: "vector",
      });
    }
  }

  // 按融合分数降序排序，取前 limit 条返回
  return Array.from(merged.values())
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}
