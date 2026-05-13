/**
 * ?????CS336 ???
 * ???packages/gateway/webSearchProvider.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import type { WebSearchInput, WebSearchOutput, WebSearchResult } from "./types";

export interface TavilySearchOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
  score?: number;
  published_date?: string;
}

interface TavilyResponse {
  query?: string;
  results?: TavilyResult[];
  answer?: string;
  response_time?: number;
}

const FRESHNESS_MAP: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

/**
 * 函数 `tavilySearch` 的职责说明。
 * `tavilySearch` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export async function tavilySearch(
  input: WebSearchInput,
  options: TavilySearchOptions
): Promise<WebSearchOutput> {
  const apiKey = options.apiKey;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not configured. Set TAVILY_API_KEY in your .env file to enable web search.");
  }

  const query = input.query.trim();
  if (!query) {
    throw new Error("web.search query must not be empty.");
  }

  const maxResults = clampMaxResults(input.maxResults);
  const baseUrl = options.baseUrl ?? "https://api.tavily.com";
  const timeoutMs = options.timeoutMs ?? 15000;

  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: maxResults,
    include_answer: false,
  };

  if (input.topic && input.topic !== "general") {
    body.topic = input.topic;
  }

  if (input.includeDomains && input.includeDomains.length > 0) {
    body.include_domains = input.includeDomains;
  }

  if (input.excludeDomains && input.excludeDomains.length > 0) {
    body.exclude_domains = input.excludeDomains;
  }

  if (input.freshness && input.freshness !== "any") {
    const tavilyFreshness = FRESHNESS_MAP[input.freshness];
    if (tavilyFreshness) {
      body.days = freshnessToDays(input.freshness);
    }
  }

  const startTime = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Tavily API error ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const data = (await response.json()) as TavilyResponse;
    const durationMs = Date.now() - startTime;

    const results: WebSearchResult[] = (data.results ?? []).map(normalizeTavilyResult);

    return {
      query: data.query ?? query,
      results,
      provider: "tavily",
      totalResults: results.length,
      searchDurationMs: durationMs,
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Tavily API timeout after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 函数 `normalizeTavilyResult` 的职责说明。
 * `normalizeTavilyResult` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizeTavilyResult(item: TavilyResult): WebSearchResult {
  return {
    title: typeof item.title === "string" ? item.title : "",
    url: typeof item.url === "string" ? item.url : "",
    snippet: typeof item.content === "string"
      ? item.content.slice(0, 500)
      : typeof item.snippet === "string"
        ? item.snippet.slice(0, 500)
        : "",
    source: "tavily",
    publishedDate: typeof item.published_date === "string" ? item.published_date : undefined,
    score: typeof item.score === "number" ? item.score : undefined,
  };
}

/**
 * 函数 `clampMaxResults` 的职责说明。
 * `clampMaxResults` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function clampMaxResults(value: number | undefined): number {
  if (value === undefined || value === null) {
    return 5;
  }
  const num = Math.floor(value);
  if (!Number.isFinite(num) || num < 1) {
    return 1;
  }
  return Math.min(num, 10);
}

/**
 * 函数 `freshnessToDays` 的职责说明。
 * `freshnessToDays` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function freshnessToDays(freshness: string): number {
  switch (freshness) {
    case "day":
      return 1;
    case "week":
      return 7;
    case "month":
      return 30;
    case "year":
      return 365;
    default:
      return 365;
  }
}

/**
 * 函数 `validateSearchInput` 的职责说明。
 * `validateSearchInput` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function validateSearchInput(input: WebSearchInput): string | null {
  if (!input.query || input.query.trim().length === 0) {
    return "web.search query must not be empty.";
  }
  if (input.query.length > 300) {
    return `web.search query length (${input.query.length}) exceeds maximum of 300 characters.`;
  }
  return null;
}
