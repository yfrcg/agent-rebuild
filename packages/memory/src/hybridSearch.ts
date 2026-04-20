import { getDb } from "../../storage/src/db";
import { vectorSearch } from "./vectorSearch";
import type { MemorySearchResult } from "./types";

// RRF（倒数排名融合）：完全抛弃绝对分数，只看排名
// 公式：score = Σ 1/(rank + k)，k=60 是惯例值
function rrfScore(rank: number, k = 60) {
  return 1 / (rank + k);
}

export async function hybridSearch(query: string, limit = 5): Promise<MemorySearchResult[]> {
  const db = getDb();

  // FTS 全文检索
  let ftsHits: MemorySearchResult[] = [];
  try {
    const ftsStmt = db.prepare(`
      SELECT chunkId, filePath, section, content
      FROM mem_fts
      WHERE mem_fts MATCH ?
      LIMIT ?
    `);

    const rows = ftsStmt.all(query, limit) as Array<{
      chunkId: string;
      filePath: string;
      section: string;
      content: string;
    }>;

    ftsHits = rows.map((row, idx) => ({
      ...row,
      score: rrfScore(idx),
      source: "fts" as const,
    }));
  } catch {
    ftsHits = [];
  }

  // 向量检索
  const vectorHits = (await vectorSearch(query, limit)).map((hit, idx) => ({
    ...hit,
    score: hit.score ?? rrfScore(idx),
    source: "vector" as const,
  }));

  // 混合检索：RRF 分数累加
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
    } else {
      merged.set(hit.chunkId, {
        ...hit,
        source: "vector",
      });
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}
