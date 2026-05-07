
import * as path from "node:path";

import {
  resolveProjectRoot as resolveConfiguredProjectRoot,
  resolveWorkspaceRoot,
} from "../core/src/config";

export type GatewayModelName = "mock" | "deepseek" | "tokenplan";
export const GATEWAY_MODEL_NAMES: readonly GatewayModelName[] = [
  "mock",
  "deepseek",
  "tokenplan",
];
export type GatewaySandboxMode = "off" | "workspace-write" | "read-only";

export interface GatewayRuntimeConfig {
  model: GatewayModelName;
  memoryTopK: number;
  auditLogPath: string;
  debug: boolean;
  sandboxMode: GatewaySandboxMode;
  sandboxAllowedRoots: string[];
  confirmTokenTtlMs: number;
  autoToolLoopEnabled: boolean;
  autoReviewGraphEnabled: boolean;
  autoToolLoopMaxSteps: number;
  devTaskMaxSteps: number;
  devTaskMaxFixRounds: number;
  sessionAutoCompactEnabled: boolean;
  sessionAutoCompactMaxEntries: number;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  sloMaxRtMs: number;
  sloMaxErrorRate: number;
  tavilyApiKey: string;
}

/**
 * 函数 `loadGatewayConfig` 的职责说明。
 * `loadGatewayConfig` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function loadGatewayConfig(
  env: NodeJS.ProcessEnv = process.env
): GatewayRuntimeConfig {
  const projectRoot = resolveConfiguredProjectRoot(env);
  const workspaceRoot = resolveWorkspaceRoot(env);

  return {
    model: parseModelName(env.GATEWAY_MODEL),
    memoryTopK: parsePositiveInteger(env.GATEWAY_MEMORY_TOP_K, 5),
    auditLogPath: env.GATEWAY_AUDIT_LOG_PATH ?? "logs/audit/gateway-audit.jsonl",
    debug: parseBoolean(env.GATEWAY_DEBUG, false),
    sandboxMode: parseLegacySandboxMode(
      env.GATEWAY_SANDBOX_GUARD_MODE ?? env.GATEWAY_SANDBOX_MODE
    ),
    sandboxAllowedRoots: parseSandboxRoots(
      env.GATEWAY_SANDBOX_ALLOWED_ROOTS ?? env.SANDBOX_ROOT,
      projectRoot,
      workspaceRoot
    ),
    confirmTokenTtlMs: parsePositiveInteger(env.GATEWAY_CONFIRM_TOKEN_TTL_MS, 300_000),
    autoToolLoopEnabled: parseBoolean(env.GATEWAY_AUTO_TOOL_LOOP_ENABLED, true),
    autoReviewGraphEnabled: parseBoolean(env.GATEWAY_AUTO_REVIEW_GRAPH_ENABLED, false),
    autoToolLoopMaxSteps: parsePositiveInteger(env.GATEWAY_AUTO_TOOL_LOOP_MAX_STEPS, 5),
    devTaskMaxSteps: parsePositiveInteger(env.GATEWAY_DEV_TASK_MAX_STEPS, 15),
    devTaskMaxFixRounds: parsePositiveInteger(env.GATEWAY_DEV_TASK_MAX_FIX_ROUNDS, 3),
    sessionAutoCompactEnabled: parseBoolean(
      env.GATEWAY_SESSION_AUTO_COMPACT_ENABLED,
      true
    ),
    sessionAutoCompactMaxEntries: parsePositiveInteger(
      env.GATEWAY_SESSION_AUTO_COMPACT_MAX_ENTRIES,
      80
    ),
    rateLimitMaxRequests: parsePositiveInteger(env.GATEWAY_RATE_LIMIT_MAX_REQUESTS, 30),
    rateLimitWindowMs: parsePositiveInteger(env.GATEWAY_RATE_LIMIT_WINDOW_MS, 60_000),
    circuitFailureThreshold: parsePositiveInteger(
      env.GATEWAY_CIRCUIT_FAILURE_THRESHOLD,
      3
    ),
    circuitCooldownMs: parsePositiveInteger(env.GATEWAY_CIRCUIT_COOLDOWN_MS, 30_000),
    sloMaxRtMs: parsePositiveInteger(env.GATEWAY_SLO_MAX_RT_MS, 200),
    sloMaxErrorRate: parseBoundedNumber(env.GATEWAY_SLO_MAX_ERROR_RATE, 0.1, 0, 1),
    tavilyApiKey: env.TAVILY_API_KEY?.trim() ?? "",
  };
}

/**
 * 函数 `parseSandboxRoots` 的职责说明。
 * `parseSandboxRoots` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parseSandboxRoots(
  value: string | undefined,
  projectRoot: string,
  workspaceRoot: string
): string[] {
  if (value === undefined || value.trim() === "") {
    return [projectRoot, workspaceRoot];
  }

  const resolved = value
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      path.isAbsolute(part) ? path.resolve(part) : path.resolve(projectRoot, part)
    );

  return [...new Set([projectRoot, workspaceRoot, ...resolved])];
}

/**
 * 函数 `parseLegacySandboxMode` 的职责说明。
 * `parseLegacySandboxMode` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parseLegacySandboxMode(value: string | undefined): GatewaySandboxMode {
  if (value === undefined || value.trim() === "") {
    return "off";
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "workspace-write" ||
    normalized === "read-only"
  ) {
    return normalized;
  }

  return "off";
}

/**
 * 函数 `parseModelName` 的职责说明。
 * `parseModelName` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parseModelName(value: string | undefined): GatewayModelName {
  const normalized = normalizeGatewayModelName(value);
  if (normalized) {
    return normalized;
  }

  if (value === undefined || value.trim() === "") {
    return "deepseek";
  }

  return "deepseek";
}

export function normalizeGatewayModelName(
  value: string | undefined
): GatewayModelName | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "minimax" || normalized === "mini-max") {
    return "tokenplan";
  }

  return (GATEWAY_MODEL_NAMES as readonly string[]).includes(normalized)
    ? (normalized as GatewayModelName)
    : undefined;
}

/**
 * 函数 `parsePositiveInteger` 的职责说明。
 * `parsePositiveInteger` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parsePositiveInteger(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

/**
 * 函数 `parsePositiveNumber` 的职责说明。
 * `parsePositiveNumber` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

/**
 * 函数 `parseBoundedNumber` 的职责说明。
 * `parseBoundedNumber` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parseBoundedNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

/**
 * 函数 `parseBoolean` 的职责说明。
 * `parseBoolean` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}
