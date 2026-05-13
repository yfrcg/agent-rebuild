/**
 * ?????CS336 ???
 * ???packages/gateway/localCommandRunner.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

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
  alreadyTranslated?: boolean;
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

const LINUX_TO_POWERSHELL: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /^ls\s+(.+)$/, replacement: "Get-ChildItem $1" },
  { pattern: /^ls$/, replacement: "Get-ChildItem" },
  { pattern: /^cat\s+(.+)$/, replacement: "Get-Content $1" },
  { pattern: /^rm\s+-rf?\s+(.+)$/, replacement: "Remove-Item -Recurse -Force $1" },
  { pattern: /^rm\s+(.+)$/, replacement: "Remove-Item $1" },
  { pattern: /^mkdir\s+-p\s+(.+)$/, replacement: "New-Item -ItemType Directory -Force -Path $1" },
  { pattern: /^mkdir\s+(.+)$/, replacement: "New-Item -ItemType Directory -Path $1" },
  { pattern: /^cp\s+(.+)$/, replacement: "Copy-Item $1" },
  { pattern: /^mv\s+(.+)$/, replacement: "Move-Item $1" },
  { pattern: /^touch\s+(.+)$/, replacement: "New-Item -ItemType File -Path $1 -Force" },
  { pattern: /^pwd$/, replacement: "Get-Location" },
  { pattern: /^which\s+(.+)$/, replacement: "Get-Command $1" },
  { pattern: /^echo\s+"(.+)"\s*>\s*(.+)$/, replacement: 'Set-Content -Path $2 -Value "$1"' },
  { pattern: /^echo\s+'(.+)'\s*>\s*(.+)$/, replacement: "Set-Content -Path $2 -Value '$1'" },
  { pattern: /^echo\s+(.+)\s*>\s*(.+)$/, replacement: 'Set-Content -Path $2 -Value "$1"' },
  { pattern: /^echo\s+(.+)$/, replacement: "Write-Output $1" },
  { pattern: /^grep\s+(-[a-zA-Z]*\s+)?(.+?)\s+(.+)$/, replacement: "Select-String -Path $3 -Pattern '$2'" },
  { pattern: /^find\s+(\.\s+)?-name\s+(.+)$/, replacement: "Get-ChildItem -Recurse -Filter $2" },
  { pattern: /^find\s+(.+)\s+-name\s+(.+)$/, replacement: "Get-ChildItem -Path $1 -Recurse -Filter $2" },
  { pattern: /^test\s+-f\s+(.+)$/, replacement: "Test-Path -Path $1 -PathType Leaf" },
  { pattern: /^test\s+-d\s+(.+)$/, replacement: "Test-Path -Path $1 -PathType Container" },
  { pattern: /^test\s+-e\s+(.+)$/, replacement: "Test-Path -Path $1" },
  { pattern: /^export\s+(\w+)=(.+)$/, replacement: '$env:$1 = "$2"' },
  { pattern: /^export\s+(\w+)="(.+)"$/, replacement: '$env:$1 = "$2"' },
  { pattern: /^export\s+(\w+)='(.+)'$/, replacement: "$env:$1 = '$2'" },
  { pattern: /^source\s+(.+)$/, replacement: ". $1" },
];

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    // Count consecutive backslashes before this character
    let backslashCount = 0;
    for (let j = index - 1; j >= 0 && command[j] === "\\"; j -= 1) {
      backslashCount += 1;
    }
    const escaped = backslashCount % 2 === 1;

    if (char === "'" && !inDoubleQuote && !escaped) {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }

    if (char === "\"" && !inSingleQuote && !escaped) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function isKnownDirOption(token: string): boolean {
  const lower = token.toLowerCase();
  return (
    lower === "/b" ||
    lower === "/s" ||
    lower === "/ad" ||
    lower === "/a:d" ||
    lower === "/a-d" ||
    lower === "/a:-d" ||
    lower === "/o:n" ||
    lower === "/o:-n" ||
    lower === "/o:s" ||
    lower === "/o:-s"
  );
}

function translateDirCommand(tokens: string[]): string {
  const options = new Set<string>();
  const paths: string[] = [];

  for (const token of tokens.slice(1)) {
    if (token.startsWith("/") && isKnownDirOption(token)) {
      options.add(token.toLowerCase());
      continue;
    }
    paths.push(token);
  }

  const parts = ["Get-ChildItem"];
  if (options.has("/b")) {
    parts.push("-Name");
  }
  if (options.has("/s")) {
    parts.push("-Recurse");
  }
  if (options.has("/ad") || options.has("/a:d")) {
    parts.push("-Directory");
  }
  if (options.has("/a-d") || options.has("/a:-d")) {
    parts.push("-File");
  }
  if (paths.length > 0) {
    parts.push("-Path", paths.join(" "));
  }

  return parts.join(" ");
}

function translateWindowsCommand(command: string): string {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return command;
  }

  const verb = tokens[0].toLowerCase();
  switch (verb) {
    case "dir":
      return translateDirCommand(tokens);
    case "type":
      return tokens.length > 1 ? `Get-Content ${tokens.slice(1).join(" ")}` : command;
    case "del":
    case "erase":
      return tokens.length > 1 ? `Remove-Item -Force ${tokens.slice(1).join(" ")}` : command;
    case "rmdir":
    case "rd": {
      const paths = tokens.slice(1).filter((token) => !/^\/[sq]$/i.test(token));
      return paths.length > 0
        ? `Remove-Item -Recurse -Force ${paths.join(" ")}`
        : command;
    }
    case "copy":
      return tokens.length >= 3
        ? `Copy-Item ${tokens[1]} ${tokens.slice(2).join(" ")}`
        : command;
    case "move":
      return tokens.length >= 3
        ? `Move-Item ${tokens[1]} ${tokens.slice(2).join(" ")}`
        : command;
    default:
      return command;
  }
}

function translateLinuxCommand(command: string): string {
  const trimmed = command.trim();
  for (const { pattern, replacement } of LINUX_TO_POWERSHELL) {
    if (pattern.test(trimmed)) {
      return trimmed.replace(pattern, replacement);
    }
  }
  return command;
}

export function translateCommand(command: string): string {
  const steps = splitCommandChain(command);
  if (steps.length === 1) {
    return translateSingleCommand(steps[0].segment);
  }

  // Group adjacent pipe-connected segments into pipe-chains,
  // then join pipe-chains with their original operators.
  const groups: Array<{ translated: string; operator?: ChainOperator }> = [];
  let pipeChain: string[] = [];

  for (let index = 0; index < steps.length; index += 1) {
    pipeChain.push(translateSingleCommand(steps[index].segment));

    const op = steps[index].operator;
    if (op !== "|") {
      // End of pipe chain — flush
      groups.push({ translated: pipeChain.join(" | "), operator: op });
      pipeChain = [];
    }
  }
  if (pipeChain.length > 0) {
    groups.push({ translated: pipeChain.join(" | ") });
  }

  const parts: string[] = [];
  for (const group of groups) {
    parts.push(group.translated);
    if (group.operator === "&&") {
      parts.push("if (-not $?) { exit $LASTEXITCODE }");
    } else if (group.operator === "||") {
      parts.push("if ($?) { exit 0 }");
    }
    // ";" is the default joiner in PowerShell, handled by join("; ")
  }

  return parts.join("; ");
}

function translateSingleCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return trimmed;
  }

  const cmdCompatible = translateWindowsCommand(trimmed);
  const normalizedRelativeExec = cmdCompatible.replace(/^\.\//, ".\\");
  const normalizedBareExec = normalizeBareExecutable(normalizedRelativeExec);
  return translateLinuxCommand(normalizedBareExec);
}

function normalizeBareExecutable(command: string): string {
  if (/^[.\\/]/.test(command) || /^[a-z]:\\/i.test(command)) {
    return command;
  }

  const match = command.match(/^([^\s\\/:"|?*]+\.(?:exe|cmd|bat|ps1))(\s.*)?$/i);
  if (!match) {
    return command;
  }

  return `.\\${match[1]}${match[2] ?? ""}`;
}

type ChainOperator = "&&" | "||" | "|" | ";";

interface ChainSegment {
  segment: string;
  operator?: ChainOperator;
}

function splitCommandChain(command: string): ChainSegment[] {
  const result: ChainSegment[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    // Check for backslash escape (handle consecutive backslashes)
    let backslashCount = 0;
    for (let j = index - 1; j >= 0 && command[j] === "\\"; j -= 1) {
      backslashCount += 1;
    }
    const escaped = backslashCount % 2 === 1;

    if (char === "'" && !inDoubleQuote && !escaped) {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }

    if (char === "\"" && !inSingleQuote && !escaped) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }

    if (inSingleQuote || inDoubleQuote) {
      current += char;
      continue;
    }

    // Double-character operators: && and ||
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      result.push({
        segment: current.trim(),
        operator: char === "&" ? "&&" : "||",
      });
      current = "";
      index += 1;
      continue;
    }

    // Single-character operators: | (pipe) and ; (semicolon)
    if (char === "|") {
      result.push({ segment: current.trim(), operator: "|" });
      current = "";
      continue;
    }

    if (char === ";") {
      result.push({ segment: current.trim(), operator: ";" });
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim() || result.length === 0) {
    result.push({ segment: current.trim() });
  }

  return result.filter((item) => item.segment !== "");
}

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
  const translatedCommand = request.alreadyTranslated
    ? request.command
    : translateCommand(request.command);

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
      translatedCommand,
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
      request.signal?.removeEventListener("abort", abortHandler);
    };

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
      const durationMs = Date.now() - startMs;
      const stdout = truncateBuffer(Buffer.concat(stdoutChunks), MAX_STDOUT_BYTES);
      const stderr = truncateBuffer(Buffer.concat(stderrChunks), MAX_STDERR_BYTES);
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr ? `${stderr}\n[spawn error]` : "[spawn error]",
        durationMs,
        timedOut,
      });
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
