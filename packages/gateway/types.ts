
import type { GatewayToolCallRecord } from "./toolCallTypes";
import type { GatewayProjectBoundary } from "./toolCallTypes";
import type {
  GatewayPermissionMode,
  GatewayPlanState,
} from "./permissionTypes";

export type { ChatMessage } from "../core/src/types";

/**
 * 模型对话消息角色类型。
 */
export type ChatRole = "system" | "user" | "assistant";

/**
 * Gateway 入口请求结构。
 */
export interface GatewayRequest {
  id: string;
  input: string;
  sessionId?: string;
  userId?: string;
  activeSkills?: string[];
  permissionMode?: GatewayPermissionMode;
  planState?: GatewayPlanState;
  createdAt: string;
  projectBoundary?: GatewayProjectBoundary;
}

/**
 * 记忆检索结果结构。
 */
export interface MemorySearchResult {
  id: string;
  content: string;
  score?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 限流信息的统一展示结构。
 */
export interface GatewayRateLimitInfo {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  limit: number;
  windowMs: number;
}

/**
 * 指标快照结构。
 */
export interface GatewayMetricsInfo {
  totalRequests: number;
  errorRequests: number;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  rateLimitedRequests: number;
  circuitOpenRequests: number;
  circuitState: "closed" | "open" | "half-open";
  slo: {
    maxRtMs: number;
    maxErrorRate: number;
    rtOk: boolean;
    errorRateOk: boolean;
  };
}

/**
 * Debug 模式下附带的额外信息。
 */
export interface GatewayDebugInfo {
  modelProvider: string;
  memoryCount: number;
  durationMs: number;
  hasError: boolean;
  errorMessage?: string;
  autoToolLoop?: {
    enabled: boolean;
    attempted: boolean;
    toolCallCount: number;
    maxSteps: number;
    finishReason: string;
    plannerError?: string;
    availableTools?: Array<{
      name: string;
      automationLevel?: string;
      riskLevel?: string;
    }>;
    decisionTrace?: Array<{
      step: number;
      action: "respond" | "tool" | "error";
      toolName?: string;
      reason?: string;
      status?: string;
      error?: string;
    }>;
  };
  memorySelection?: {
    hitCount: number;
    sourceBreakdown: Record<string, number>;
    topMemoryIds: string[];
    hasRecentMemory: boolean;
  };
  skillSelection?: {
    discoveredSkillCount: number;
    activatedSkills: string[];
    matchedSkills: string[];
    strategy: "explicit" | "session" | "auto" | "mixed" | "none";
  };
  permission?: {
    mode: GatewayPermissionMode;
  };
  plan?: GatewayPlanState;
  rateLimit?: GatewayRateLimitInfo;
  circuit?: {
    open: boolean;
    state?: string;
    reason?: string;
  };
  sandbox?: {
    mode: string;
    allowedRoots: string[];
    backend?: string;
    enabled?: boolean;
    containerMode?: string;
  };
  metrics?: GatewayMetricsInfo;
  devTask?: {
    active: boolean;
    devTaskMode: boolean;
    maxSteps: number;
    currentStep: number;
    filesModified: string[];
    commandsRun: number;
    testsPassed: number;
    testsFailed: number;
    testResults: Array<{ command: string; passed: boolean; summary: string }>;
    fixRounds: number;
    maxFixRounds: number;
    finalSummary?: string;
    status: "running" | "passed" | "failed" | "stopped";
  };
}

/**
 * Gateway 最终响应结构。
 */
export interface GatewayResponse {
  id: string;
  text: string;
  memoryUsed: MemorySearchResult[];
  toolCalls?: GatewayToolCallRecord[];
  error?: string;
  debug?: GatewayDebugInfo;
  createdAt: string;
}

export type GatewayInternalEvent =
  | {
      type: "chat.delta";
      delta: string;
    }
  | {
      type: "tool.started";
      toolName: string;
      toolCallId: string;
      inputPreview?: unknown;
    }
  | {
      type: "tool.finished" | "tool.failed" | "tool.denied";
      toolCall: GatewayToolCallRecord;
    };

export interface GatewayHandleOptions {
  signal?: AbortSignal;
  onEvent?: (event: GatewayInternalEvent) => void | Promise<void>;
}

export interface WebSearchInput {
  query: string;
  maxResults?: number;
  topic?: "general" | "news" | "finance";
  includeDomains?: string[];
  excludeDomains?: string[];
  freshness?: "day" | "week" | "month" | "year" | "any";
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedDate?: string;
  score?: number;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
  provider: string;
  totalResults: number;
  searchDurationMs: number;
}
