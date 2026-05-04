import * as path from "node:path";

import {
  resolveProjectRoot as resolveConfiguredProjectRoot,
  resolveWorkspaceRoot,
} from "../core/src/config";
import { loadSandboxConfig } from "../sandbox/src/config";
import type { SandboxConfig } from "../sandbox/src/types";

export type GatewayModelName = "mock" | "deepseek";
export type GatewaySandboxMode = "off" | "workspace-write" | "read-only";

export interface GatewayRuntimeConfig {
  model: GatewayModelName;
  memoryTopK: number;
  auditLogPath: string;
  debug: boolean;
  sandboxMode: GatewaySandboxMode;
  sandboxAllowedRoots: string[];
  sandbox: SandboxConfig;
  confirmTokenTtlMs: number;
  autoToolLoopEnabled: boolean;
  autoToolLoopMaxSteps: number;
  sessionAutoCompactEnabled: boolean;
  sessionAutoCompactMaxEntries: number;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  sloMaxRtMs: number;
  sloMaxErrorRate: number;
}

export function loadGatewayConfig(
  env: NodeJS.ProcessEnv = process.env
): GatewayRuntimeConfig {
  const projectRoot = resolveConfiguredProjectRoot(env);
  const workspaceRoot = resolveWorkspaceRoot(env);

  return {
    model: parseModelName(env.GATEWAY_MODEL),
    memoryTopK: parsePositiveInteger(env.GATEWAY_MEMORY_TOP_K, 5),
    auditLogPath: env.GATEWAY_AUDIT_LOG_PATH ?? "logs/gateway-audit.jsonl",
    debug: parseBoolean(env.GATEWAY_DEBUG, false),
    sandboxMode: parseLegacySandboxMode(
      env.GATEWAY_SANDBOX_GUARD_MODE ?? env.GATEWAY_SANDBOX_MODE
    ),
    sandboxAllowedRoots: parseSandboxRoots(
      env.GATEWAY_SANDBOX_ALLOWED_ROOTS ?? env.SANDBOX_ROOT,
      projectRoot,
      workspaceRoot
    ),
    sandbox: loadSandboxConfig(env),
    confirmTokenTtlMs: parsePositiveInteger(env.GATEWAY_CONFIRM_TOKEN_TTL_MS, 300_000),
    autoToolLoopEnabled: parseBoolean(env.GATEWAY_AUTO_TOOL_LOOP_ENABLED, true),
    autoToolLoopMaxSteps: parsePositiveInteger(env.GATEWAY_AUTO_TOOL_LOOP_MAX_STEPS, 5),
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
    sloMaxErrorRate: parsePositiveNumber(env.GATEWAY_SLO_MAX_ERROR_RATE, 0.1),
  };
}

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

function parseLegacySandboxMode(value: string | undefined): GatewaySandboxMode {
  if (value === undefined || value.trim() === "") {
    return "workspace-write";
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "workspace-write" ||
    normalized === "read-only"
  ) {
    return normalized;
  }

  return "workspace-write";
}

function parseModelName(value: string | undefined): GatewayModelName {
  if (value === undefined || value.trim() === "" || value === "deepseek") {
    return "deepseek";
  }

  if (value === "mock") {
    return "mock";
  }

  return "deepseek";
}

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
