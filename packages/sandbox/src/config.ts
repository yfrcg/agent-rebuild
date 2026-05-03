import * as path from "node:path";

import { DEFAULT_SANDBOX_PROFILES } from "./policy";
import type { SandboxBackendName, SandboxConfig } from "./types";

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  backend: "docker",
  dockerImage: "agentrebuild-sandbox:latest",
  auditLogPath: path.resolve(process.cwd(), "logs", "sandbox-audit.jsonl"),
  profiles: DEFAULT_SANDBOX_PROFILES,
  maxStdoutBytes: 200 * 1024,
  maxStderrBytes: 200 * 1024,
};

export function loadSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<SandboxConfig> = {}
): SandboxConfig {
  return {
    backend: parseBackend(
      env.GATEWAY_SANDBOX_BACKEND,
      env.SANDBOX_MODE,
      overrides.backend
    ),
    dockerImage:
      env.GATEWAY_SANDBOX_IMAGE?.trim() ||
      overrides.dockerImage ||
      DEFAULT_SANDBOX_CONFIG.dockerImage,
    auditLogPath: path.resolve(
      process.cwd(),
      env.GATEWAY_SANDBOX_AUDIT_LOG_PATH?.trim() ||
        overrides.auditLogPath ||
        DEFAULT_SANDBOX_CONFIG.auditLogPath
    ),
    profiles: overrides.profiles ?? DEFAULT_SANDBOX_CONFIG.profiles,
    maxStdoutBytes: parsePositiveInteger(
      env.GATEWAY_SANDBOX_MAX_STDOUT_BYTES,
      overrides.maxStdoutBytes ?? DEFAULT_SANDBOX_CONFIG.maxStdoutBytes
    ),
    maxStderrBytes: parsePositiveInteger(
      env.GATEWAY_SANDBOX_MAX_STDERR_BYTES,
      overrides.maxStderrBytes ?? DEFAULT_SANDBOX_CONFIG.maxStderrBytes
    ),
  };
}

function parseBackend(
  value: string | undefined,
  sandboxMode: string | undefined,
  fallback?: SandboxBackendName
): SandboxBackendName {
  const normalizedMode = sandboxMode?.trim().toLowerCase();
  if (normalizedMode === "wsl") {
    return "remote";
  }

  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "docker" ||
    normalized === "bubblewrap" ||
    normalized === "nsjail" ||
    normalized === "remote"
  ) {
    return normalized;
  }

  return fallback ?? DEFAULT_SANDBOX_CONFIG.backend;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}
