export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GatewayRequest {
  id: string;
  input: string;
  sessionId?: string;
  userId?: string;
  createdAt: string;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  score?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface GatewayRateLimitInfo {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  limit: number;
  windowMs: number;
}

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

export interface GatewayDebugInfo {
  modelProvider: string;
  memoryCount: number;
  durationMs: number;
  hasError: boolean;
  rateLimit?: GatewayRateLimitInfo;
  metrics?: GatewayMetricsInfo;
}

export interface GatewayResponse {
  id: string;
  text: string;
  memoryUsed: MemorySearchResult[];
  error?: string;
  debug?: GatewayDebugInfo;
  createdAt: string;
}
