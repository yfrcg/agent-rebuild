export type GatewayModelName = "mock" | "deepseek";

export interface GatewayRuntimeConfig {
  model: GatewayModelName;
  memoryTopK: number;
  auditLogPath: string;
  debug: boolean;
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
  return {
    model: parseModelName(env.GATEWAY_MODEL),
    memoryTopK: parsePositiveInteger(env.GATEWAY_MEMORY_TOP_K, 5),
    auditLogPath: env.GATEWAY_AUDIT_LOG_PATH ?? "logs/gateway-audit.jsonl",
    debug: parseBoolean(env.GATEWAY_DEBUG, false),
    rateLimitMaxRequests: parsePositiveInteger(env.GATEWAY_RATE_LIMIT_MAX_REQUESTS, 30),
    rateLimitWindowMs: parsePositiveInteger(env.GATEWAY_RATE_LIMIT_WINDOW_MS, 60_000),
    circuitFailureThreshold: parsePositiveInteger(env.GATEWAY_CIRCUIT_FAILURE_THRESHOLD, 3),
    circuitCooldownMs: parsePositiveInteger(env.GATEWAY_CIRCUIT_COOLDOWN_MS, 30_000),
    sloMaxRtMs: parsePositiveInteger(env.GATEWAY_SLO_MAX_RT_MS, 200),
    sloMaxErrorRate: parsePositiveNumber(env.GATEWAY_SLO_MAX_ERROR_RATE, 0.1),
  };
}

function parseModelName(value: string | undefined): GatewayModelName {
  if (value === "deepseek") {
    return "deepseek";
  }

  if (value === "minimax") {
    console.warn(
      `[gateway config] GATEWAY_MODEL="minimax" is deprecated, use "deepseek" instead`
    );
    return "deepseek";
  }

  if (value === "mock" || value === undefined || value.trim() === "") {
    return "mock";
  }

  console.warn(`[gateway config] unknown GATEWAY_MODEL="${value}", fallback to mock`);

  return "mock";
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
    console.warn(
      `[gateway config] invalid positive integer "${value}", fallback to ${fallback}`
    );

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
    console.warn(
      `[gateway config] invalid positive number "${value}", fallback to ${fallback}`
    );

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

  console.warn(
    `[gateway config] invalid boolean "${value}", fallback to ${fallback}`
  );

  return fallback;
}
