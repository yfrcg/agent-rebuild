import { spawn } from "node:child_process";
import * as path from "node:path";

import { assertInsideWorkspace, validateBindMountSource } from "./pathGuard";
import type {
  SandboxAvailability,
  SandboxBackend,
  SandboxProfile,
  SandboxRequest,
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
];
const ALLOWED_ENV_KEYS = new Set([
  "CI",
  "NODE_ENV",
  "FORCE_COLOR",
  "NO_COLOR",
  "TERM",
  "COLORTERM",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "NPM_CONFIG_LOGLEVEL",
  "UV_NO_SYNC",
]);

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
    const result = await this.spawnProcess(["version", "--format", "{{.Client.Version}}"], 10_000);
    if (result.error) {
      return {
        ok: false,
        error: result.error,
      };
    }

    return {
      ok: result.exitCode === 0,
      version: firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr),
      error: result.exitCode === 0 ? undefined : firstNonEmptyLine(result.stderr) ?? "docker unavailable",
    };
  }

  async run(req: SandboxRequest, profile: SandboxProfile): Promise<SandboxResult> {
    const projectRoot = path.resolve(req.projectRoot);
    validateBindMountSource(projectRoot);
    assertInsideWorkspace(resolveWorkingDirectory(req), projectRoot);

    const dockerArgs = this.buildDockerArgs(req, profile, projectRoot);
    const startedAt = Date.now();
    const result = await this.spawnProcess(dockerArgs, profile.timeoutMs, req.stdin);

    return {
      ok: result.exitCode === 0 && !result.error,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.error ? appendError(result.stderr, result.error) : result.stderr,
      durationMs: Date.now() - startedAt,
    };
  }

  buildDockerArgs(req: SandboxRequest, profile: SandboxProfile, projectRoot = path.resolve(req.projectRoot)): string[] {
    const workspaceMode = profile.workspaceAccess === "ro" ? "ro" : "rw";
    const workdir = toWorkspaceDir(req, projectRoot);
    const envEntries = [
      ["CI", "1"],
      ["NODE_ENV", "test"],
      ["HOME", "/tmp/sandbox-home"],
      ...Object.entries(filterAllowedEnv(req.env)),
    ];

    const args = [
      "run",
      "--rm",
      "--network",
      translateNetwork(profile.network),
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,size=256m",
      "--tmpfs",
      "/run:rw,nosuid,size=64m",
      "--memory",
      `${profile.memoryMb}m`,
      "--cpus",
      String(profile.cpus),
      "--pids-limit",
      String(profile.pidsLimit),
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "-v",
      `${projectRoot}:/workspace:${workspaceMode}`,
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
    stdin?: string
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; error?: string }> {
    return await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let finished = false;
      const child = spawn(this.dockerCommand, args, {
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      });

      const finalize = (result: { exitCode: number | null; stdout: string; stderr: string; error?: string }) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finalize({
          exitCode: null,
          stdout,
          stderr: appendError(stderr, `[sandbox] command timed out after ${timeoutMs}ms`),
        });
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout = appendLimited(stdout, chunk, this.stdoutLimitBytes);
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = appendLimited(stderr, chunk, this.stderrLimitBytes);
      });

      child.on("error", (error) => {
        finalize({
          exitCode: null,
          stdout,
          stderr,
          error: friendlyDockerError(this.dockerCommand, error),
        });
      });

      child.on("close", (code) => {
        finalize({
          exitCode: code,
          stdout,
          stderr,
        });
      });

      if (stdin) {
        child.stdin?.write(stdin, "utf8");
      }
      child.stdin?.end();
    });
  }
}

function resolveWorkingDirectory(req: SandboxRequest): string {
  const projectRoot = path.resolve(req.projectRoot);
  if (!req.cwd) {
    return projectRoot;
  }

  return path.resolve(projectRoot, req.cwd);
}

function toWorkspaceDir(req: SandboxRequest, projectRoot: string): string {
  const cwd = resolveWorkingDirectory(req);
  const relative = path.relative(projectRoot, cwd).replace(/\\/g, "/");
  return relative === "" ? "/workspace" : path.posix.join("/workspace", relative);
}

function translateNetwork(mode: SandboxProfile["network"]): string {
  switch (mode) {
    case "host":
      return "host";
    case "restricted":
      return "bridge";
    case "none":
    default:
      return "none";
  }
}

function filterAllowedEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) {
    return {};
  }

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.trim().toUpperCase();
    if (!normalizedKey || BLOCKED_ENV_KEYS.includes(normalizedKey)) {
      continue;
    }

    if (normalizedKey.includes("KEY") || normalizedKey.includes("TOKEN") || normalizedKey.includes("SECRET") || normalizedKey.includes("PASSWORD")) {
      continue;
    }

    if (!ALLOWED_ENV_KEYS.has(normalizedKey)) {
      continue;
    }

    filtered[normalizedKey] = value;
  }

  return filtered;
}

function appendLimited(current: string, chunk: Buffer | string, limit: number): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next, "utf8") <= limit) {
    return next;
  }

  const suffix = "\n[truncated]";
  const trimmed = Buffer.from(next, "utf8").subarray(0, Math.max(0, limit - Buffer.byteLength(suffix, "utf8")));
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
