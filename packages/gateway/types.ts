import type { GatewayToolCallRecord } from "./toolCallTypes";

/**
 * 模型对话消息角色类型。
 */
export type ChatRole = "system" | "user" | "assistant";

/**
 * 发给模型的标准消息结构。
 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Gateway 入口请求结构。
 */
export interface GatewayRequest {
  id: string;
  input: string;
  sessionId?: string;
  userId?: string;
  activeSkills?: string[];
  createdAt: string;
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
