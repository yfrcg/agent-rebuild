import * as http from "node:http";
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_WSL_PROJECT_ROOT,
} from "../../core/src/config";
import { assertInsideWorkspace } from "./pathGuard";
import { SandboxManager } from "./sandboxManager";
import type {
  SandboxRequest,
  SandboxRequestedNetworkMode,
} from "./types";

export interface SandboxWorkerRunRequestBody {
  command?: unknown;
  cwd?: unknown;
  windowsCwd?: unknown;
  timeoutMs?: unknown;
  env?: unknown;
  envAllowlist?: unknown;
  workspaceMount?: unknown;
  networkPolicy?: unknown;
  resourceLimits?: unknown;
}

export interface SandboxWorkerServerOptions {
  apiKey?: string;
  allowedRoot?: string;
  manager?: SandboxManager;
  useDocker?: boolean;
}

export function createSandboxWorkerServer(
  options: SandboxWorkerServerOptions = {}
): http.Server {
  const manager = options.manager ?? new SandboxManager();
  const apiKey = (options.apiKey ?? process.env.SANDBOX_API_KEY ?? "").trim();
  const allowedRoot = path.resolve(
    options.allowedRoot ?? process.env.SANDBOX_ALLOWED_ROOT ?? DEFAULT_WSL_PROJECT_ROOT
  );
  const useDocker = options.useDocker ?? manager.backend.name === "docker";

  return http.createServer(async (req, res) => {
    try {
      if (req.url === "/health" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          allowedRoot,
          useDocker,
          backend: manager.backend.name,
        });
      }

      if (req.url === "/run" && req.method === "POST") {
        if (apiKey && readBearerToken(req) !== apiKey) {
          return sendJson(res, 401, {
            error: "Unauthorized",
          });
        }

        const body = await readJsonBody(req);
        const normalizedRequest = normalizeSandboxWorkerRunRequest(body, {
          allowedRoot,
        });
        const result = await manager.exec(normalizedRequest);
        return sendJson(res, 200, {
          ok: result.ok,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: result.timedOut === true,
          artifacts: result.artifacts ?? [],
        });
      }

      return sendJson(res, 404, {
        error: "Not found",
      });
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: 0,
        timedOut: false,
        artifacts: [],
      });
    }
  });
}

export function normalizeSandboxWorkerRunRequest(
  body: SandboxWorkerRunRequestBody,
  options: {
    allowedRoot?: string;
  } = {}
): SandboxRequest {
  const allowedRoot = path.resolve(options.allowedRoot ?? DEFAULT_WSL_PROJECT_ROOT);
  const command =
    typeof body.command === "string" && body.command.trim() !== ""
      ? body.command.trim()
      : undefined;
  if (!command) {
    throw new Error("[sandbox-worker] command is required");
  }

  const workspaceMountInput =
    typeof body.workspaceMount === "string" && body.workspaceMount.trim() !== ""
      ? body.workspaceMount.trim()
      : undefined;
  if (!workspaceMountInput) {
    throw new Error("[sandbox-worker] workspaceMount is required");
  }

  const workspaceMount = resolveWorkerPath(workspaceMountInput, allowedRoot);
  if (!existsSync(workspaceMount)) {
    throw new Error(`[sandbox-worker] workspaceMount does not exist: ${workspaceMountInput}`);
  }

  const cwdInput =
    typeof body.cwd === "string" && body.cwd.trim() !== ""
      ? body.cwd.trim()
      : typeof body.windowsCwd === "string" && body.windowsCwd.trim() !== ""
        ? body.windowsCwd.trim()
        : workspaceMountInput;
  const cwd = resolveWorkerPath(cwdInput, allowedRoot);
  if (!existsSync(cwd)) {
    throw new Error(`[sandbox-worker] cwd does not exist: ${cwdInput}`);
  }
  const workspaceRealPath = realpathSync.native(workspaceMount);
  const cwdRealPath = realpathSync.native(cwd);
  assertInsideWorkspace(cwdRealPath, workspaceRealPath);
  assertInsideWorkspace(workspaceRealPath, allowedRoot);

  return {
    sessionId: "wsl-worker",
    profileName: "safe-dev",
    toolName: "sandbox.exec",
    command,
    cwd: cwdRealPath,
    projectRoot: workspaceRealPath,
    workspaceMount: workspaceRealPath,
    timeoutMs: readPositiveNumber(body.timeoutMs),
    env: normalizeEnv(body.env),
    envAllowlist: normalizeStringArray(body.envAllowlist),
    networkPolicy: normalizeNetworkPolicy(body.networkPolicy),
    resourceLimits: normalizeResourceLimits(body.resourceLimits),
  };
}

function readBearerToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) {
    return undefined;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(req: http.IncomingMessage): Promise<SandboxWorkerRunRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[sandbox-worker] request body must be a JSON object");
  }

  return parsed as SandboxWorkerRunRequestBody;
}

function resolveWorkerPath(inputPath: string, allowedRoot: string): string {
  const normalized = shouldTranslateWindowsPath(inputPath)
    ? windowsPathToWsl(inputPath)
    : inputPath;
  const resolved = path.resolve(normalized);
  assertInsideWorkspace(resolved, allowedRoot);
  return resolved;
}

function shouldTranslateWindowsPath(value: string): boolean {
  return process.platform !== "win32" && looksLikeWindowsPath(value);
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function windowsPathToWsl(windowsPath: string): string {
  const drive = windowsPath[0]?.toLowerCase();
  const remainder = windowsPath.slice(2).replace(/\\/g, "/");
  return `/mnt/${drive}${remainder}`;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof envValue === "string" && key.trim()) {
      env[key.trim()] = envValue;
    }
  }

  return Object.keys(env).length > 0 ? env : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const output = value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
  return output.length > 0 ? output : [];
}

function normalizeNetworkPolicy(value: unknown): SandboxRequestedNetworkMode | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "disabled" ||
    normalized === "limited" ||
    normalized === "enabled" ||
    normalized === "none" ||
    normalized === "restricted" ||
    normalized === "host"
  ) {
    return normalized as SandboxRequestedNetworkMode;
  }

  throw new Error(`[sandbox-worker] unsupported networkPolicy: ${value}`);
}

function normalizeResourceLimits(value: unknown): SandboxRequest["resourceLimits"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const limits: NonNullable<SandboxRequest["resourceLimits"]> = {};
  const memoryMb = readPositiveNumber(source.memoryMb);
  const cpus =
    typeof source.cpus === "number" && Number.isFinite(source.cpus) && source.cpus > 0
      ? source.cpus
      : undefined;
  const pidsLimit = readPositiveNumber(source.pidsLimit);
  const maxOutputBytes = readPositiveNumber(source.maxOutputBytes);

  if (memoryMb !== undefined) {
    limits.memoryMb = memoryMb;
  }
  if (cpus !== undefined) {
    limits.cpus = cpus;
  }
  if (pidsLimit !== undefined) {
    limits.pidsLimit = pidsLimit;
  }
  if (maxOutputBytes !== undefined) {
    limits.maxOutputBytes = maxOutputBytes;
  }

  return Object.keys(limits).length > 0 ? limits : undefined;
}
