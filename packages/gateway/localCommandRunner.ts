
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
  signal?: AbortSignal;
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

/**
 * 函数 `buildChildEnv` 的职责说明。
 * `buildChildEnv` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

/**
 * 函数 `truncateBuffer` 的职责说明。
 * `truncateBuffer` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function truncateBuffer(buffer: Buffer, limit: number): string {
  if (buffer.length <= limit) {
    return buffer.toString("utf8");
  }

  return buffer.subarray(0, limit).toString("utf8");
}

/**
 * 函数 `isInsideWorkspace` 的职责说明。
 * `isInsideWorkspace` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function isInsideWorkspace(target: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(target);
  const normalizedRoot = path.resolve(workspaceRoot);
  const sep = path.sep;
  return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + sep);
}

/**
 * 函数 `runLocalCommand` 的职责说明。
 * `runLocalCommand` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

    /** 函数变量 `cleanup`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
    const cleanup = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      request.signal?.removeEventListener("abort", abortHandler);
    };

    /** 函数变量 `abortHandler`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
    const abortHandler = () => {
      timedOut = false;
      try {
        child.kill("SIGTERM");
      } catch {
        // process may have already exited
      }
    };

    if (request.signal?.aborted) {
      abortHandler();
    } else {
      request.signal?.addEventListener("abort", abortHandler, { once: true });
    }

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
