import { spawn } from "node:child_process";
import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import * as path from "node:path";

import { assertInsideWorkspace, validateBindMountSource } from "./pathGuard";
import type {
  SandboxAvailability,
  SandboxBackend,
  SandboxProfile,
  SandboxRequest,
  SandboxRequestedNetworkMode,
  SandboxResult,
} from "./types";

const DEFAULT_STDOUT_LIMIT = 200 * 1024;
const DEFAULT_STDERR_LIMIT = 200 * 1024;
const DEFAULT_IMAGE = "agentrebuild-sandbox:latest";
const BLOCKED_ENV_KEYS = [
  "SSH_AUTH_SOCK",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
];
const MINIMAL_DEFAULT_ENV: Record<string, string> = {
  CI: "true",
  NODE_ENV: "test",
  HOME: "/tmp/sandbox-home",
};

export interface DockerSandboxBackendOptions {
  dockerCommand?: string;
  image?: string;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
}

export class DockerSandboxBackend implements SandboxBackend {
  readonly name = "docker";
  readonly image: string;
  private readonly dockerCommand: string;
  private readonly stdoutLimitBytes: number;
  private readonly stderrLimitBytes: number;

  constructor(options: DockerSandboxBackendOptions = {}) {
    this.dockerCommand = options.dockerCommand ?? "docker";
    this.image = options.image ?? DEFAULT_IMAGE;
    this.stdoutLimitBytes = options.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT;
    this.stderrLimitBytes = options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT;
  }

  async checkAvailability(): Promise<SandboxAvailability> {
    const result = await this.spawnProcess(
      ["version", "--format", "{{.Client.Version}}"],
      10_000,
      undefined,
      {
        stdoutLimitBytes: this.stdoutLimitBytes,
        stderrLimitBytes: this.stderrLimitBytes,
      }
    );
    if (result.error) {
      return {
        ok: false,
        error: result.error,
      };
    }

    return {
      ok: result.exitCode === 0,
      version: firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr),
      error:
        result.exitCode === 0
          ? undefined
          : firstNonEmptyLine(result.stderr) ?? "docker unavailable",
    };
  }

  async run(req: SandboxRequest, profile: SandboxProfile): Promise<SandboxResult> {
    const workspaceMount = resolveWorkspaceMount(req);
    const cwd = resolveWorkingDirectory(req, workspaceMount);
    validateBindMountSource(workspaceMount);
    assertInsideWorkspace(cwd, workspaceMount);

    const timeoutMs = normalizeTimeout(req.timeoutMs, profile.timeoutMs);
    const maxOutputBytes = normalizeMaxOutputBytes(
      req.resourceLimits?.maxOutputBytes,
      Math.max(this.stdoutLimitBytes, this.stderrLimitBytes)
    );
    const dockerArgs = this.buildDockerArgs(req, profile, workspaceMount);
    const startedAt = Date.now();
    const result = await this.spawnProcess(dockerArgs, timeoutMs, req.stdin, {
      stdoutLimitBytes: maxOutputBytes,
      stderrLimitBytes: maxOutputBytes,
    });
    const artifacts = collectArtifacts(workspaceMount);

    return {
      ok: result.exitCode === 0 && !result.error && !result.timedOut,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.error ? appendError(result.stderr, result.error) : result.stderr,
      durationMs: Date.now() - startedAt,
      timedOut: result.timedOut,
      artifacts,
    };
  }

  buildDockerArgs(
    req: SandboxRequest,
    profile: SandboxProfile,
    workspaceMount = resolveWorkspaceMount(req)
  ): string[] {
    const workspaceMode = profile.workspaceAccess === "ro" ? "ro" : "rw";
    const workdir = toWorkspaceDir(req, workspaceMount);
    const envEntries = Object.entries(
      buildContainerEnv(req.env, req.envAllowlist)
    );
    const memoryMb = req.resourceLimits?.memoryMb ?? profile.memoryMb;
    const cpus = req.resourceLimits?.cpus ?? profile.cpus;
    const pidsLimit = req.resourceLimits?.pidsLimit ?? profile.pidsLimit;
    const network = normalizeRequestedNetwork(req.networkPolicy ?? profile.network);

    const args = [
      "run",
      "--rm",
      "--init",
      "--user",
      "node",
      "--network",
      translateNetwork(network),
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,size=256m",
      "--tmpfs",
      "/run:rw,nosuid,size=64m",
      "--memory",
      `${memoryMb}m`,
      "--cpus",
      String(cpus),
      "--pids-limit",
      String(pidsLimit),
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "-v",
      `${workspaceMount}:/workspace:${workspaceMode}`,
      "-w",
      workdir,
    ];

    for (const [key, value] of envEntries) {
      args.push("-e", `${key}=${value}`);
    }

    args.push(this.image, "sh", "-lc", req.command?.trim() || "true");
    return args;
  }

  private async spawnProcess(
    args: string[],
    timeoutMs: number,
    stdin: string | undefined,
    limits: {
      stdoutLimitBytes: number;
      stderrLimitBytes: number;
    }
  ): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    error?: string;
  }> {
    return await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let finished = false;
      let timedOut = false;
      const child = spawn(this.dockerCommand, args, {
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      });

      const finalize = (result: {
        exitCode: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
        error?: string;
      }) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
        finalize({
          exitCode: null,
          stdout,
          stderr: appendError(stderr, `[sandbox] command timed out after ${timeoutMs}ms`),
          timedOut: true,
        });
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout = appendLimited(stdout, chunk, limits.stdoutLimitBytes);
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = appendLimited(stderr, chunk, limits.stderrLimitBytes);
      });

      child.on("error", (error) => {
        finalize({
          exitCode: null,
          stdout,
          stderr,
          timedOut,
          error: friendlyDockerError(this.dockerCommand, error),
        });
      });

      child.on("close", (code) => {
        finalize({
          exitCode: timedOut ? null : code,
          stdout,
          stderr,
          timedOut,
        });
      });

      if (stdin) {
        child.stdin?.write(stdin, "utf8");
      }
      child.stdin?.end();
    });
  }
}

function resolveWorkspaceMount(req: SandboxRequest): string {
  const candidate = req.workspaceMount ?? req.projectRoot;
  if (!candidate || candidate.trim() === "") {
    throw new Error("[sandbox] workspaceMount is required");
  }

  const resolved = path.resolve(candidate);
  if (!existsSync(resolved)) {
    throw new Error(`[sandbox] workspaceMount does not exist: ${candidate}`);
  }

  return realpathSync.native(resolved);
}

function resolveWorkingDirectory(req: SandboxRequest, workspaceMount: string): string {
  if (!req.cwd || req.cwd.trim() === "") {
    return workspaceMount;
  }

  const candidate = path.isAbsolute(req.cwd)
    ? req.cwd
    : path.resolve(workspaceMount, req.cwd);
  return path.resolve(candidate);
}

function toWorkspaceDir(req: SandboxRequest, workspaceMount: string): string {
  const cwd = resolveWorkingDirectory(req, workspaceMount);
  const relative = path.relative(workspaceMount, cwd).replace(/\\/g, "/");
  return relative === "" ? "/workspace" : path.posix.join("/workspace", relative);
}

function translateNetwork(mode: "none" | "restricted" | "host"): string {
  switch (mode) {
    case "host":
      return "bridge";
    case "restricted":
      return "bridge";
    case "none":
    default:
      return "none";
  }
}

function normalizeRequestedNetwork(
  mode: SandboxRequestedNetworkMode
): "none" | "restricted" | "host" {
  switch (mode) {
    case "enabled":
      return "restricted";
    case "limited":
      return "none";
    case "disabled":
      return "none";
    case "host":
    case "restricted":
    case "none":
      return mode;
    default:
      return "none";
  }
}

function buildContainerEnv(
  env: Record<string, string> | undefined,
  envAllowlist: string[] | undefined
): Record<string, string> {
  const allowlist = new Set(
    (envAllowlist ?? [])
      .filter((key): key is string => typeof key === "string" && key.trim() !== "")
      .map((key) => key.trim().toUpperCase())
  );

  const filtered: Record<string, string> = {
    ...MINIMAL_DEFAULT_ENV,
  };

  if (!env) {
    return filtered;
  }

  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.trim().toUpperCase();
    if (!normalizedKey || BLOCKED_ENV_KEYS.includes(normalizedKey)) {
      continue;
    }

    if (
      normalizedKey.includes("KEY") ||
      normalizedKey.includes("TOKEN") ||
      normalizedKey.includes("SECRET") ||
      normalizedKey.includes("PASSWORD")
    ) {
      continue;
    }

    if (allowlist.size > 0 && !allowlist.has(normalizedKey)) {
      continue;
    }

    if (allowlist.size === 0 && !(normalizedKey === "CI" || normalizedKey === "NODE_ENV")) {
      continue;
    }

    filtered[normalizedKey] = value;
  }

  return filtered;
}

function normalizeTimeout(input: number | undefined, fallback: number): number {
  if (!Number.isFinite(input) || input === undefined || input <= 0) {
    return fallback;
  }

  return Math.floor(input);
}

function normalizeMaxOutputBytes(input: number | undefined, fallback: number): number {
  if (!Number.isFinite(input) || input === undefined || input <= 0) {
    return fallback;
  }

  return Math.floor(input);
}

function collectArtifacts(
  workspaceMount: string
): Array<{ path: string; sizeBytes?: number; kind?: string; description?: string }> {
  const artifactsDir = path.join(workspaceMount, "artifacts");
  if (!existsSync(artifactsDir)) {
    return [];
  }

  const results: Array<{ path: string; sizeBytes?: number; kind?: string; description?: string }> = [];
  walkArtifacts(artifactsDir, workspaceMount, results);
  return results;
}

function walkArtifacts(
  currentDir: string,
  workspaceMount: string,
  results: Array<{ path: string; sizeBytes?: number; kind?: string; description?: string }>
): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const absolutePath = path.join(currentDir, entry.name);
    assertInsideWorkspace(absolutePath, workspaceMount);
    if (entry.isDirectory()) {
      walkArtifacts(absolutePath, workspaceMount, results);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const stat = statSync(absolutePath);
    results.push({
      path: absolutePath,
      sizeBytes: stat.size,
      kind: path.extname(absolutePath).replace(/^\./, "") || "file",
    });
  }
}

function appendLimited(current: string, chunk: Buffer | string, limit: number): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next, "utf8") <= limit) {
    return next;
  }

  const suffix = "\n[truncated]";
  const trimmed = Buffer.from(next, "utf8").subarray(
    0,
    Math.max(0, limit - Buffer.byteLength(suffix, "utf8"))
  );
  return trimmed.toString("utf8") + suffix;
}

function appendError(stderr: string, message: string): string {
  return stderr ? `${stderr}\n${message}` : message;
}

function firstNonEmptyLine(input: string): string | undefined {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function friendlyDockerError(command: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ENOENT")) {
    return `[sandbox] docker is not installed or not on PATH: ${command}`;
  }

  return `[sandbox] docker backend failed: ${message}`;
}
