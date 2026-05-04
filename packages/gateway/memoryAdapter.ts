import { hybridSearch } from "../memory/src/hybridSearch";
import type { MemorySearch } from "./gateway";
import type { MemorySearchResult } from "./types";

/**
 * 创建适配 Gateway 的记忆检索函数。
 *
 * 底层真实搜索来自 memory 模块的 `hybridSearch`，
 * 这里负责把搜索结果整理成 Gateway 前端统一消费的结构。
 */
export function createGatewayMemorySearch(topK = 5): MemorySearch {
  return async function gatewayMemorySearch(
    query: string
  ): Promise<MemorySearchResult[]> {
    const hits = await hybridSearch(query, topK);

    return hits.map((hit, index) => {
      return {
        id: createMemoryResultId(hit.filePath, hit.section, index),
        content: hit.content,
        source: hit.filePath,
        score: hit.score,
        metadata: {
          section: hit.section,
          filePath: hit.filePath,
          date: hit.date,
          sourceKind: hit.source,
          freshness: inferFreshness(hit.date, hit.source),
          freshnessWarning:
            inferFreshness(hit.date, hit.source) === "stale"
              ? "Older project/reference memory. Re-verify against current files before acting on it."
              : undefined,
        },
      };
    });
  };
}

/**
 * 为记忆命中结果生成稳定的展示 ID。
 *
 * 这里把来源文件路径与 section 组合起来，便于日志、调试和输出层定位来源。
 */
function createMemoryResultId(
  filePath: string,
  section: string | undefined,
  index: number
): string {
  return `${filePath}#${section ?? index + 1}`;
}

function inferFreshness(
  date: string | undefined,
  sourceKind: string | undefined
): "recent" | "stale" | "timeless" {
  if (!date) {
    return sourceKind === "fts" || sourceKind === "vector" || sourceKind === "hybrid"
      ? "timeless"
      : "timeless";
  }

  const timestamp = Date.parse(`${date}T00:00:00+08:00`);
  if (Number.isNaN(timestamp)) {
    return "timeless";
  }

  const ageDays = Math.floor((Date.now() - timestamp) / 86_400_000);
  return ageDays > 30 ? "stale" : "recent";
}
