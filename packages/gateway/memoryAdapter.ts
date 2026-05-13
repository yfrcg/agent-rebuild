/**
 * ?????CS336 ???
 * ???packages/gateway/memoryAdapter.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

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
    let hits: Awaited<ReturnType<typeof hybridSearch>>;
    try {
      hits = await hybridSearch(query, topK);
    } catch (err) {
      // Memory search must never crash the gateway
      console.warn("[memoryAdapter] hybridSearch failed:", err instanceof Error ? err.message : err);
      return [];
    }

    if (!Array.isArray(hits)) {
      console.warn("[memoryAdapter] hybridSearch returned non-array:", typeof hits);
      return [];
    }

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

/**
 * 函数 `inferFreshness` 的职责说明。
 * `inferFreshness` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
