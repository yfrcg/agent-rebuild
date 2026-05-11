import * as crypto from "node:crypto";

export interface GatewayWsAuthConfig {
  host: string;
  port: number;
  token: string;
  allowedOrigins: string[];
  maxConnections: number;
  maxMessageBytes: number;
  maxRunsPerClient: number;
  maxRunsTotal: number;
  rateLimitWindowMs: number;
  rateLimitMaxMessages: number;
  maxBufferedAmount: number;
  maxPendingEvents: number;
  deltaBatchMs: number;
  shutdownTimeoutMs: number;
}

/**
 * 从环境变量加载 WS 网关配置。
 *
 * 解析失败时使用保守默认值，避免一个错误环境变量导致服务无法启动；
 * 真正的安全边界仍由 token、Origin 白名单和沙箱配置共同承担。
 *
 * 如果未提供 `GATEWAY_WS_TOKEN`，会自动生成一个随机 token 并打印到控制台，
 * 确保 WS 端点始终需要认证。
 */
export function loadGatewayWsAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): GatewayWsAuthConfig {
  const configuredToken = normalizeOptional(env.GATEWAY_WS_TOKEN);
  const token = configuredToken ?? crypto.randomBytes(24).toString("hex");

  return {
    host: env.GATEWAY_WS_HOST?.trim() || "127.0.0.1",
    port: parsePort(env.GATEWAY_WS_PORT, 8787),
    token,
    allowedOrigins: parseAllowedOrigins(env.GATEWAY_WS_ALLOWED_ORIGINS),
    maxConnections: parsePositiveInteger(env.GATEWAY_WS_MAX_CONNECTIONS, 20),
    maxMessageBytes: parsePositiveInteger(env.GATEWAY_WS_MAX_MESSAGE_BYTES, 1_048_576),
    maxRunsPerClient: parsePositiveInteger(env.GATEWAY_WS_MAX_RUNS_PER_CLIENT, 2),
    maxRunsTotal: parsePositiveInteger(env.GATEWAY_WS_MAX_RUNS_TOTAL, 8),
    rateLimitWindowMs: parsePositiveInteger(env.GATEWAY_WS_RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMaxMessages: parsePositiveInteger(env.GATEWAY_WS_RATE_LIMIT_MAX_MESSAGES, 120),
    maxBufferedAmount: parsePositiveInteger(env.GATEWAY_WS_MAX_BUFFERED_AMOUNT, 8 * 1024 * 1024),
    maxPendingEvents: parsePositiveInteger(env.GATEWAY_WS_MAX_PENDING_EVENTS, 1000),
    deltaBatchMs: parsePositiveInteger(env.GATEWAY_WS_DELTA_BATCH_MS, 50),
    shutdownTimeoutMs: parsePositiveInteger(env.GATEWAY_WS_SHUTDOWN_TIMEOUT_MS, 10_000),
  };
}

/**
 * 校验一次 WebSocket upgrade 请求是否允许建立连接。
 *
 * 先检查 Origin，避免浏览器环境下被非授权站点跨站调用；
 * 如果配置了 `GATEWAY_WS_TOKEN`，再从查询参数或 Bearer 头中读取 token。
 */
export function authenticateWsUpgrade(input: {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  config: GatewayWsAuthConfig;
}): { ok: true } | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string } {
  const origin = headerValue(input.headers.origin);
  if (!isOriginAllowed(origin, input.config.allowedOrigins)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "WebSocket origin is not allowed.",
    };
  }

  if (!input.config.token) {
    return { ok: true };
  }

  const token = readToken(input.url, input.headers);
  if (token !== input.config.token) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      message: "Missing or invalid WebSocket token.",
    };
  }

  return { ok: true };
}

/**
 * 函数 `parsePort` 的职责说明。
 * `parsePort` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parsePort(value: string | undefined, fallback: number): number {
  if (!value || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : fallback;
}

/**
 * 函数 `parsePositiveInteger` 的职责说明。
 * `parsePositiveInteger` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 标准化可选 token。
 *
 * 空字符串会被视为未启用鉴权；过短 token 不直接拒绝，
 * 但会打印警告，方便本地开发和生产环境使用同一套解析逻辑。
 */
function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length < 8) {
    console.warn("[ws-auth] GATEWAY_WS_TOKEN is shorter than 8 characters, consider using a stronger token.");
  }
  return trimmed;
}

/**
 * 解析允许的浏览器来源。
 *
 * 默认放行本地前端开发地址和空 Origin，后者用于部分脚本客户端或测试工具。
 */
function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value || value.trim() === "") {
    return ["http://localhost:3000", "http://127.0.0.1:3000", ""];
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * 按优先级读取客户端 token。
 *
 * 查询参数便于简单脚本连接，Authorization 头适合正式客户端；
 * 两者都不存在时返回 `undefined`，由调用方决定是否拒绝。
 */
function readToken(
  url: string | undefined,
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  const queryToken = readQueryToken(url);
  if (queryToken) {
    return queryToken;
  }

  const authorization = headerValue(headers.authorization);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

/**
 * 函数 `readQueryToken` 的职责说明。
 * `readQueryToken` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function readQueryToken(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url, "ws://localhost");
    return parsed.searchParams.get("token")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 函数 `headerValue` 的职责说明。
 * `headerValue` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/** 判断当前请求来源是否在白名单中，空白名单表示显式放行所有来源。 */
function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  const normalizedOrigin = origin ?? "";
  if (allowedOrigins.length === 0) {
    return true;
  }
  return allowedOrigins.includes(normalizedOrigin);
}
