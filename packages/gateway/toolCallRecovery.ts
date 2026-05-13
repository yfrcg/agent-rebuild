/**
 * Intelligent tool call recovery system.
 *
 * When a tool call fails, this module attempts to recover by:
 * 1. Analyzing the failure type
 * 2. Using other tools to discover what the user actually meant
 * 3. Retrying with corrected parameters
 *
 * This eliminates "file not found" and similar errors by automatically
 * discovering the correct path/command/tool.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolRegistry } from "./toolRegistry";
import type { ToolCallExecutor } from "./toolCallExecutor";
import type { GatewayToolCallRecord, GatewayToolCallRequest } from "./toolCallTypes";

export interface RecoveryContext {
  registry: ToolRegistry;
  executor: ToolCallExecutor;
  projectRoot: string;
  sessionId?: string;
  requestId?: string;
  signal?: AbortSignal;
}

export interface RecoveryResult {
  recovered: boolean;
  record?: GatewayToolCallRecord;
  suggestion?: string;
  correctedInput?: Record<string, unknown>;
}

/**
 * Attempt to recover from a failed tool call.
 *
 * This function analyzes the failure and tries alternative approaches:
 * - For file operations: discovers similar files using file.list
 * - For shell commands: suggests alternative commands
 * - For path errors: resolves partial paths
 */
export async function attemptToolCallRecovery(
  failedRecord: GatewayToolCallRecord,
  originalRequest: GatewayToolCallRequest,
  context: RecoveryContext
): Promise<RecoveryResult> {
  const error = failedRecord.result?.error ?? failedRecord.output?.error ?? "";

  // File not found errors
  if (isFileNotFoundError(error, failedRecord.toolName)) {
    return recoverFromFileNotFound(failedRecord, originalRequest, context);
  }

  // Path resolution errors
  if (isPathResolutionError(error)) {
    return recoverFromPathError(failedRecord, originalRequest, context);
  }

  // Command not found errors
  if (isCommandNotFoundError(error)) {
    return recoverFromCommandNotFound(failedRecord, originalRequest, context);
  }

  return { recovered: false };
}

/**
 * Check if the error is a file not found error.
 */
function isFileNotFoundError(error: string, toolName: string): boolean {
  const lowerError = error.toLowerCase();
  return (
    lowerError.includes("no such file") ||
    lowerError.includes("file not found") ||
    lowerError.includes("enoent") ||
    lowerError.includes("找不到") ||
    (toolName === "file.read" && lowerError.includes("does not exist"))
  );
}

/**
 * Check if the error is a path resolution error.
 */
function isPathResolutionError(error: string): boolean {
  const lowerError = error.toLowerCase();
  return (
    lowerError.includes("invalid path") ||
    lowerError.includes("path does not exist") ||
    lowerError.includes("路径") ||
    lowerError.includes("directory not found")
  );
}

/**
 * Check if the error is a command not found error.
 */
function isCommandNotFoundError(error: string): boolean {
  const lowerError = error.toLowerCase();
  return (
    lowerError.includes("command not found") ||
    lowerError.includes("is not recognized") ||
    lowerError.includes("not recognized as an internal") ||
    lowerError.includes("不是内部或外部命令")
  );
}

/**
 * Recover from file not found by discovering similar files.
 */
async function recoverFromFileNotFound(
  failedRecord: GatewayToolCallRecord,
  originalRequest: GatewayToolCallRequest,
  context: RecoveryContext
): Promise<RecoveryResult> {
  const inputPath = extractPathFromInput(originalRequest.input);
  if (!inputPath) {
    return { recovered: false };
  }

  const basename = path.basename(inputPath);
  const dirname = path.dirname(inputPath);

  // Try to list the directory to find similar files
  const listResult = await executeToolCall(
    "file.list",
    { path: dirname || "." },
    context
  );

  if (!listResult || listResult.status !== "success") {
    return { recovered: false };
  }

  const files = extractFileList(listResult);
  if (!files || files.length === 0) {
    return { recovered: false };
  }

  // Find the best match
  const match = findBestMatch(basename, files);
  if (!match) {
    return {
      recovered: false,
      suggestion: `文件 "${basename}" 不存在。目录中的文件: ${files.slice(0, 10).join(", ")}`,
    };
  }

  // Retry with the matched file
  const correctedPath = path.join(dirname, match);
  const correctedInput = { ...originalRequest.input, path: correctedPath };

  const retryResult = await executeToolCall(
    originalRequest.toolName,
    correctedInput,
    context
  );

  if (retryResult && retryResult.status === "success") {
    return {
      recovered: true,
      record: retryResult,
      correctedInput,
      suggestion: `自动修正: "${basename}" → "${match}"`,
    };
  }

  return {
    recovered: false,
    suggestion: `找到相似文件 "${match}"，但读取失败`,
  };
}

/**
 * Recover from path resolution errors.
 */
async function recoverFromPathError(
  failedRecord: GatewayToolCallRecord,
  originalRequest: GatewayToolCallRequest,
  context: RecoveryContext
): Promise<RecoveryResult> {
  const inputPath = extractPathFromInput(originalRequest.input);
  if (!inputPath) {
    return { recovered: false };
  }

  // Try to resolve the path by listing parent directories
  const parts = inputPath.split(path.sep);
  let currentPath = "";
  let resolvedParts: string[] = [];

  for (const part of parts) {
    if (!part) continue;

    const testPath = currentPath ? path.join(currentPath, part) : part;

    if (fs.existsSync(testPath)) {
      resolvedParts.push(part);
      currentPath = testPath;
      continue;
    }

    // Try to list the current directory to find similar names
    const listResult = await executeToolCall(
      "file.list",
      { path: currentPath || "." },
      context
    );

    if (listResult && listResult.status === "success") {
      const files = extractFileList(listResult);
      const match = findBestMatch(part, files || []);

      if (match) {
        resolvedParts.push(match);
        currentPath = path.join(currentPath, match);
        continue;
      }
    }

    // Can't resolve further
    break;
  }

  if (resolvedParts.length === parts.length) {
    const correctedPath = resolvedParts.join(path.sep);
    const correctedInput = { ...originalRequest.input, path: correctedPath };

    const retryResult = await executeToolCall(
      originalRequest.toolName,
      correctedInput,
      context
    );

    if (retryResult && retryResult.status === "success") {
      return {
        recovered: true,
        record: retryResult,
        correctedInput,
        suggestion: `自动修正路径: "${inputPath}" → "${correctedPath}"`,
      };
    }
  }

  return { recovered: false };
}

/**
 * Recover from command not found errors.
 */
async function recoverFromCommandNotFound(
  failedRecord: GatewayToolCallRecord,
  originalRequest: GatewayToolCallRequest,
  context: RecoveryContext
): Promise<RecoveryResult> {
  const command = typeof originalRequest.input.command === "string"
    ? originalRequest.input.command
    : "";

  if (!command) {
    return { recovered: false };
  }

  // Extract the base command
  const baseCommand = command.split(/\s+/)[0];

  // Common command alternatives
  const alternatives: Record<string, string[]> = {
    ls: ["dir", "Get-ChildItem"],
    dir: ["ls", "Get-ChildItem"],
    cat: ["type", "Get-Content"],
    type: ["cat", "Get-Content"],
    rm: ["del", "Remove-Item"],
    del: ["rm", "Remove-Item"],
    mv: ["move", "Move-Item"],
    move: ["mv", "Move-Item"],
    cp: ["copy", "Copy-Item"],
    copy: ["cp", "Copy-Item"],
    mkdir: ["md", "New-Item -ItemType Directory"],
    md: ["mkdir", "New-Item -ItemType Directory"],
    echo: ["Write-Output"],
    grep: ["Select-String"],
    find: ["Get-ChildItem -Recurse"],
    chmod: ["icacls"],
    pwd: ["cd", "Get-Location"],
  };

  const altCommands = alternatives[baseCommand.toLowerCase()];
  if (!altCommands) {
    return {
      recovered: false,
      suggestion: `命令 "${baseCommand}" 不存在。请使用 Windows 兼容的命令。`,
    };
  }

  // Try each alternative
  for (const altCommand of altCommands) {
    const correctedCommand = command.replace(baseCommand, altCommand);
    const correctedInput = { ...originalRequest.input, command: correctedCommand };

    const retryResult = await executeToolCall(
      "shell.run",
      correctedInput,
      context
    );

    if (retryResult && retryResult.status === "success") {
      return {
        recovered: true,
        record: retryResult,
        correctedInput,
        suggestion: `自动修正命令: "${baseCommand}" → "${altCommand}"`,
      };
    }
  }

  return {
    recovered: false,
    suggestion: `命令 "${baseCommand}" 不存在。尝试: ${altCommands.join(", ")}`,
  };
}

/**
 * Extract a file path from tool input.
 */
function extractPathFromInput(input: Record<string, unknown>): string | undefined {
  if (typeof input.path === "string") return input.path;
  if (typeof input.filePath === "string") return input.filePath;
  if (typeof input.file === "string") return input.file;
  if (typeof input.target === "string") return input.target;
  return undefined;
}

/**
 * Extract file list from a file.list tool result.
 */
function extractFileList(record: GatewayToolCallRecord): string[] | undefined {
  const output = record.output;
  if (!output) return undefined;

  // Try different output formats
  const content = output.content;
  if (Array.isArray(content)) {
    return content.map(String);
  }

  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Not JSON, try splitting by newlines
      return content.split("\n").filter(Boolean);
    }
  }

  return undefined;
}

/**
 * Find the best match for a filename from a list of files.
 * Uses fuzzy matching to handle extensions, case, and partial matches.
 */
function findBestMatch(target: string, files: string[]): string | undefined {
  const targetLower = target.toLowerCase();
  const targetNoExt = removeExtension(targetLower);

  // Exact match (case-insensitive)
  const exactMatch = files.find((f) => f.toLowerCase() === targetLower);
  if (exactMatch) return exactMatch;

  // Same name, different extension
  const sameNameDiffExt = files.find((f) => {
    const fileLower = f.toLowerCase();
    const fileNoExt = removeExtension(fileLower);
    return fileNoExt === targetNoExt;
  });
  if (sameNameDiffExt) return sameNameDiffExt;

  // Starts with target
  const startsWith = files.find((f) =>
    f.toLowerCase().startsWith(targetLower)
  );
  if (startsWith) return startsWith;

  // Target starts with file
  const targetStartsWith = files.find((f) =>
    targetLower.startsWith(f.toLowerCase())
  );
  if (targetStartsWith) return targetStartsWith;

  // Contains target
  const contains = files.find((f) =>
    f.toLowerCase().includes(targetLower)
  );
  if (contains) return contains;

  // Levenshtein distance <= 2
  const closeMatch = files.find((f) => {
    const dist = levenshteinDistance(f.toLowerCase(), targetLower);
    return dist <= 2;
  });
  if (closeMatch) return closeMatch;

  return undefined;
}

/**
 * Remove file extension from a filename.
 */
function removeExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

/**
 * Calculate Levenshtein distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Execute a tool call and return the result.
 */
async function executeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  context: RecoveryContext
): Promise<GatewayToolCallRecord | undefined> {
  const id = `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const request = {
    id,
    name: toolName,
    args: input,
    toolName,
    input,
    sessionId: context.sessionId,
    requestId: context.requestId,
    approved: true,
    permissionMode: "bypassPermissions" as const,
    signal: context.signal,
    createdAt: new Date().toISOString(),
  };

  try {
    return await context.executor.execute(request);
  } catch {
    return undefined;
  }
}
