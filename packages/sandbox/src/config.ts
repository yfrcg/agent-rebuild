import * as path from "node:path";

import type {
  SandboxConfig,
  SandboxMode,
  SandboxNetworkPolicy,
  SandboxRuntimeBackend,
  SandboxScope,
  SandboxWorkspaceAccess,
} from "./types";

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  backend: "docker",
  mode: "untrusted",
  scope: "call",
  defaultImage: "node:20-bookworm-slim",
  network: "none",
  workspaceAccess: "copy",
  workRoot: path.resolve(process.cwd(), ".agent-rebuild", "sandboxes"),
  artifactRoot: path.resolve(process.cwd(), ".agent-rebuild", "artifacts"),
  timeoutMs: 30_000,
  memoryLimit: "512m",
  cpuLimit: "1",
  pidsLimit: 128,
  maxOutputBytes: 1_048_576,
  readOnlyRootfs: false,
  auditLogPath: path.resolve(process.cwd(), "logs", "sandbox-audit.jsonl"),
  egressProxy: {
    enabled: false,
    allowDomains: [],
    blockPrivateIp: true,
    logRequests: true,
  },
};

export function loadSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<SandboxConfig> = {}
): SandboxConfig {
  const merged: SandboxConfig = {
    ...DEFAULT_SANDBOX_CONFIG,
    ...overrides,
    enabled: parseBoolean(env.GATEWAY_SANDBOX_ENABLED, overrides.enabled ?? DEFAULT_SANDBOX_CONFIG.enabled),
    backend: parseBackend(env.GATEWAY_SANDBOX_BACKEND, overrides.backend),
    mode: parseMode(env.GATEWAY_SANDBOX_MODE, overrides.mode),
    scope: parseScope(env.GATEWAY_SANDBOX_SCOPE, overrides.scope),
    defaultImage:
      env.GATEWAY_SANDBOX_DEFAULT_IMAGE?.trim() ||
      overrides.defaultImage ||
      DEFAULT_SANDBOX_CONFIG.defaultImage,
    network: parseNetwork(env.GATEWAY_SANDBOX_NETWORK, overrides.network),
    workspaceAccess: parseWorkspaceAccess(
      env.GATEWAY_SANDBOX_WORKSPACE_ACCESS,
      overrides.workspaceAccess
    ),
    workRoot: resolvePath(env.GATEWAY_SANDBOX_WORK_ROOT, overrides.workRoot, DEFAULT_SANDBOX_CONFIG.workRoot),
    artifactRoot: resolvePath(
      env.GATEWAY_SANDBOX_ARTIFACT_ROOT,
      overrides.artifactRoot,
      DEFAULT_SANDBOX_CONFIG.artifactRoot
    ),
    timeoutMs: parsePositiveInteger(
      env.GATEWAY_SANDBOX_TIMEOUT_MS,
      overrides.timeoutMs ?? DEFAULT_SANDBOX_CONFIG.timeoutMs
    ),
    memoryLimit:
      env.GATEWAY_SANDBOX_MEMORY_LIMIT?.trim() ||
      overrides.memoryLimit ||
      DEFAULT_SANDBOX_CONFIG.memoryLimit,
    cpuLimit:
      env.GATEWAY_SANDBOX_CPU_LIMIT?.trim() ||
      overrides.cpuLimit ||
      DEFAULT_SANDBOX_CONFIG.cpuLimit,
    pidsLimit: parsePositiveInteger(
      env.GATEWAY_SANDBOX_PIDS_LIMIT,
      overrides.pidsLimit ?? DEFAULT_SANDBOX_CONFIG.pidsLimit
    ),
    maxOutputBytes: parsePositiveInteger(
      env.GATEWAY_SANDBOX_MAX_OUTPUT_BYTES,
      overrides.maxOutputBytes ?? DEFAULT_SANDBOX_CONFIG.maxOutputBytes
    ),
    readOnlyRootfs: parseBoolean(
      env.GATEWAY_SANDBOX_READ_ONLY_ROOTFS,
      overrides.readOnlyRootfs ?? DEFAULT_SANDBOX_CONFIG.readOnlyRootfs
    ),
    auditLogPath: resolvePath(
      env.GATEWAY_SANDBOX_AUDIT_LOG_PATH,
      overrides.auditLogPath,
      DEFAULT_SANDBOX_CONFIG.auditLogPath
    ),
    egressProxy: {
      enabled: parseBoolean(
        env.GATEWAY_SANDBOX_EGRESS_PROXY_ENABLED,
        overrides.egressProxy?.enabled ?? DEFAULT_SANDBOX_CONFIG.egressProxy.enabled
      ),
      allowDomains: parseCsv(
        env.GATEWAY_SANDBOX_EGRESS_PROXY_ALLOW_DOMAINS,
        overrides.egressProxy?.allowDomains ?? DEFAULT_SANDBOX_CONFIG.egressProxy.allowDomains
      ),
      blockPrivateIp: parseBoolean(
        env.GATEWAY_SANDBOX_EGRESS_PROXY_BLOCK_PRIVATE_IP,
        overrides.egressProxy?.blockPrivateIp ??
          DEFAULT_SANDBOX_CONFIG.egressProxy.blockPrivateIp
      ),
      logRequests: parseBoolean(
        env.GATEWAY_SANDBOX_EGRESS_PROXY_LOG_REQUESTS,
        overrides.egressProxy?.logRequests ?? DEFAULT_SANDBOX_CONFIG.egressProxy.logRequests
      ),
    },
  };

  return merged;
}

function parseBackend(
  value: string | undefined,
  fallback?: SandboxRuntimeBackend
): SandboxRuntimeBackend {
  if (!value?.trim()) {
    return fallback ?? DEFAULT_SANDBOX_CONFIG.backend;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "docker" || normalized === "podman") {
    return normalized;
  }

  return fallback ?? DEFAULT_SANDBOX_CONFIG.backend;
}

function parseMode(value: string | undefined, fallback?: SandboxMode): SandboxMode {
  if (!value?.trim()) {
    return fallback ?? DEFAULT_SANDBOX_CONFIG.mode;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "off" || normalized === "untrusted" || normalized === "all") {
    return normalized;
  }

  return fallback ?? DEFAULT_SANDBOX_CONFIG.mode;
}

function parseScope(value: string | undefined, fallback?: SandboxScope): SandboxScope {
  if (!value?.trim()) {
    return fallback ?? DEFAULT_SANDBOX_CONFIG.scope;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "session" || normalized === "call") {
    return normalized;
  }

  return fallback ?? DEFAULT_SANDBOX_CONFIG.scope;
}

function parseNetwork(
  value: string | undefined,
  fallback?: SandboxNetworkPolicy
): SandboxNetworkPolicy {
  if (!value?.trim()) {
    return fallback ?? DEFAULT_SANDBOX_CONFIG.network;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "bridge") {
    return normalized;
  }

  return fallback ?? DEFAULT_SANDBOX_CONFIG.network;
}

function parseWorkspaceAccess(
  value: string | undefined,
  fallback?: SandboxWorkspaceAccess
): SandboxWorkspaceAccess {
  if (!value?.trim()) {
    return fallback ?? DEFAULT_SANDBOX_CONFIG.workspaceAccess;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "copy" || normalized === "ro" || normalized === "rw") {
    return normalized;
  }

  return fallback ?? DEFAULT_SANDBOX_CONFIG.workspaceAccess;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "n"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolvePath(
  value: string | undefined,
  override: string | undefined,
  fallback: string
): string {
  const raw = value?.trim() || override || fallback;
  return path.resolve(process.cwd(), raw);
}

