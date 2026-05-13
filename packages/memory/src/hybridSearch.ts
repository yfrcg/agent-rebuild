
import { getDb } from "../../storage/src/db";
import { vectorSearch } from "./vectorSearch";
import type { MemorySearchResult } from "./types";

/**
 * 计算 Reciprocal Rank Fusion 分数。
 *
 * RRF 的思想很简单：
 * 不同检索器只要都给出一个“排名”，就能用这个公式把排名融合成统一分数，
 * 既不用强依赖原始分数尺度，也能兼顾多路召回结果。
 */
function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/[\x00-\x1f]/g, " ")
    .replace(/[{}[\]()*+\-:^~!?\\\/|"';@#%&=<>~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rrfScore(rank: number, k = 60): number {
  return 1 / (rank + k);
}

// Text matches are deterministic evidence; keep them ahead of approximate vector neighbors.
function textMatchScore(rank: number): number {
  return 2 + rrfScore(rank);
}

/**
 * 函数 `extractDateFromFilePath` 的职责说明。
 * `extractDateFromFilePath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function extractDateFromFilePath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/memory\/(\d{4}-\d{2}-\d{2})\.md$/);
  return match?.[1];
}

/**
 * 函数 `daysSince` 的职责说明。
 * `daysSince` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function daysSince(dateString: string): number | undefined {
  const timestamp = Date.parse(`${dateString}T00:00:00+08:00`);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  const diffMs = Date.now() - timestamp;
  return Math.max(0, Math.floor(diffMs / 86_400_000));
}

/**
 * 函数 `computeRecencyBoost` 的职责说明。
 * `computeRecencyBoost` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function computeRecencyBoost(filePath: string, date?: string): number {
  const resolvedDate = date ?? extractDateFromFilePath(filePath);
  if (!resolvedDate) {
    return 0;
  }

  const diffDays = daysSince(resolvedDate);
  if (diffDays === undefined) {
    return 0;
  }

  if (diffDays <= 1) {
    return 0.15;
  }

  if (diffDays <= 3) {
    return 0.12;
  }

  if (diffDays <= 7) {
    return 0.08;
  }

  if (diffDays <= 14) {
    return 0.04;
  }

  if (diffDays <= 30) {
    return 0.02;
  }

  // Decay penalty for old memories: gently reduce score so newer context takes priority
  if (diffDays <= 60) {
    return -0.02;
  }

  if (diffDays <= 90) {
    return -0.05;
  }

  return -0.08;
}

/**
 * 执行混合检索。
 *
 * 流程是：
 * 1. 先走 FTS 关键词检索。
 * 2. FTS 失败或结果较弱时，回退到 LIKE 检索兜底。
 * 3. 再走向量检索。
 * 4. 用 RRF 和简单叠分把两路结果融合排序。
 */
export async function hybridSearch(
  query: string,
  limit = 5
): Promise<MemorySearchResult[]> {
  // Learning note: memory search has two recall paths. FTS/LIKE gives exact text
  // evidence, vectorSearch gives semantic neighbors, and the merge ranks both.
  const db = getDb();

  /**
   * 把 FTS 命中结果补齐 file_id。
   *
   * 因为有些检索路径直接返回的是 chunk 层信息，
   * 这里需要再查一次主表，把文件级 ID 补上给后续统一消费。
   */
  function enrichFileId(hits: MemorySearchResult[]): MemorySearchResult[] {
    if (hits.length === 0) {
      return hits;
    }

    const chunkIds = hits.map((hit) => hit.chunkId);
    const placeholders = chunkIds.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT chunkId, file_id FROM mem_docs WHERE chunkId IN (${placeholders})`)
      .all(...chunkIds) as Array<{ chunkId: string; file_id: string }>;
    const fileIdMap = new Map(rows.map((row) => [row.chunkId, row.file_id]));

    return hits.map((hit) => ({
      ...hit,
      file_id: fileIdMap.get(hit.chunkId) ?? "",
    }));
  }

  let ftsHits: MemorySearchResult[] = [];
  try {
    const ftsRows = db
      .prepare(
        `
          SELECT chunkId, filePath, section, content
          FROM mem_fts
          WHERE content MATCH ?
          LIMIT ?
        `
      )
      .all(`"${sanitizeFtsQuery(query)}"`, limit) as Array<{
      chunkId: string;
      filePath: string;
      section: string;
      content: string;
    }>;

    ftsHits = ftsRows.map((row, index) => ({
      ...row,
      file_id: "",
      date: extractDateFromFilePath(row.filePath),
      score: textMatchScore(index),
      source: "fts" as const,
    }));
  } catch {
    ftsHits = [];
  }

  // 某些情况下 FTS 查询语法会失败，或者分词效果不理想，此时退回 LIKE 保底。
  if (ftsHits.length === 0) {
    const likeRows = db
      .prepare(
        `
          SELECT chunkId, filePath, section, content
          FROM mem_docs
          WHERE content LIKE '%' || ? || '%'
          LIMIT ?
        `
      )
      .all(query, limit) as Array<{
      chunkId: string;
      filePath: string;
      section: string;
      content: string;
    }>;

    ftsHits = likeRows.map((row, index) => ({
      ...row,
      file_id: "",
      date: extractDateFromFilePath(row.filePath),
      score: textMatchScore(index),
      source: "fts" as const,
    }));
  }

  ftsHits = enrichFileId(ftsHits);

  let vectorHits: MemorySearchResult[] = [];
  try {
    vectorHits = (await vectorSearch(query, limit)).map((hit, index) => ({
      ...hit,
      score: hit.score ?? rrfScore(index),
      source: "vector" as const,
    }));
  } catch {
    // 向量检索是增强项，失败时不能影响全文检索兜底。
    vectorHits = [];
  }

  const merged = new Map<string, MemorySearchResult>();

  for (const hit of ftsHits) {
    merged.set(hit.chunkId, {
      ...hit,
      source: "fts",
    });
  }

  for (const hit of vectorHits) {
    const existing = merged.get(hit.chunkId);

    if (existing) {
      merged.set(hit.chunkId, {
        ...existing,
        score: (existing.score ?? 0) + (hit.score ?? 0),
        source: "hybrid",
      });
      continue;
    }

    merged.set(hit.chunkId, {
      ...hit,
      source: "vector",
    });
  }

  return Array.from(merged.values())
    .map((hit) => ({
      ...hit,
      score: (hit.score ?? 0) + computeRecencyBoost(hit.filePath, hit.date),
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}
