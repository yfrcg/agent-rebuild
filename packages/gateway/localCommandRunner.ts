import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;

export interface LocalCommandRequest {
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface LocalCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const BLOCKED_ENV_PATTERNS = [
  "TOKEN",
  "SECRET",
  "API_KEY",
  "PASSWORD",
  "CREDENTIAL",
];

function buildChildEnv(overrides?: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase();
    if (BLOCKED_ENV_PATTERNS.some((pattern) => upper.includes(pattern))) {
      continue;
    }

    const value = process.env[key];
    if (value !== undefined) {
      safe[key] = value;
    }
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      safe[key] = value;
    }
  }

  return safe;
}

function truncateBuffer(buffer: Buffer, limit: number): string {
  if (buffer.length <= limit) {
    return buffer.toString("utf8");
  }

  return buffer.subarray(0, limit).toString("utf8");
}

function isInsideWorkspace(target: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(target);
  const normalizedRoot = path.resolve(workspaceRoot);
  const sep = path.sep;
  return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + sep);
}

export async function runLocalCommand(
  request: LocalCommandRequest,
  workspaceRoot: string
): Promise<LocalCommandResult> {
  const resolvedCwd = path.resolve(request.cwd);
  if (!isInsideWorkspace(resolvedCwd, workspaceRoot)) {
    throw new Error(`[local-runner] cwd escapes workspace: ${request.cwd}`);
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const childEnv = buildChildEnv(request.env);
  const startMs = Date.now();

  return new Promise<LocalCommandResult>((resolve) => {
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const child: ChildProcess = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      request.command,
    ], {
      cwd: resolvedCwd,
      env: childEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes < MAX_STDOUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes < MAX_STDERR_BYTES) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    const cleanup = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // process may have already exited
      }
    }, timeoutMs);

    child.on("error", () => {
      cleanup();
    });

    child.on("close", (code) => {
      cleanup();
      const durationMs = Date.now() - startMs;
      const stdout = truncateBuffer(Buffer.concat(stdoutChunks), MAX_STDOUT_BYTES);
      const stderr = truncateBuffer(Buffer.concat(stderrChunks), MAX_STDERR_BYTES);

      resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs,
        timedOut,
      });
    });
  });
}
