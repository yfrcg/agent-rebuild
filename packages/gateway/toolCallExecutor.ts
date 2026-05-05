import * as fs from "node:fs";
import * as path from "node:path";

import { resolveProjectRoot } from "../core/src/config";
import { runLocalCommand } from "./localCommandRunner";
import { FileAccessTracker } from "./fileAccessTracker";
import { PermissionPolicy } from "./permissionPolicy";
import type {
  GatewayToolCallExecutorOptions,
  GatewayToolCallRecord,
  GatewayToolCallRequest,
  GatewayProjectBoundary,
} from "./toolCallTypes";
import type { GatewayToolOutput, ToolResult } from "./toolTypes";

const MAX_INLINE_RESULT_CHARS = 8_000;
const EXECUTION_PREVIEW_CHARS = 2_000;

export class ToolCallExecutor {
  private readonly registry: GatewayToolCallExecutorOptions["registry"];
  private readonly auditLogger?: unknown;
  private readonly sandbox?: GatewayToolCallExecutorOptions["sandbox"];
  private readonly projectRoot: string;
  private readonly permissionPolicy: PermissionPolicy;
  private readonly fileAccessTracker: FileAccessTracker;
  private readonly toolResultDir: string;

  constructor(options: GatewayToolCallExecutorOptions) {
    this.registry = options.registry;
    this.auditLogger = options.auditLogger;
    this.sandbox = options.sandbox;
    this.projectRoot = options.projectRoot ?? resolveProjectRoot();
    this.permissionPolicy = new PermissionPolicy({
      projectRoot: this.projectRoot,
      allowBypassPermissions: options.allowBypassPermissions,
    });
    this.fileAccessTracker = new FileAccessTracker();
    this.toolResultDir = path.resolve(process.cwd(), "logs", "tool-results");
  }

  async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
    const normalizedInput = normalizeToolInput(
      request.toolName,
      request.input,
      request.projectBoundary?.commandCwd ?? this.projectRoot
    );
    const tool = this.registry.get(request.toolName);
    const record: GatewayToolCallRecord = {
      id: request.id,
      toolName: request.toolName,
      input: normalizedInput,
      status: "pending",
      riskLevel: tool?.riskLevel,
      permissionLevel: tool?.permissionLevel,
      toolCall: {
        id: request.id,
        name: request.toolName,
        args: normalizedInput,
      },
      sessionId: request.sessionId,
      requestId: request.requestId,
      permissionMode: request.permissionMode,
      planState: request.planState,
      createdAt: request.createdAt,
    };

    const startedAtMs = Date.now();
    record.startedAt = new Date(startedAtMs).toISOString();
    record.status = "running";

    try {
      const validationError = this.registry.validate(request.toolName, normalizedInput);
      if (validationError) {
        this.errorRecord(record, validationError);
      } else if (!tool) {
        this.errorRecord(record, `[tools] tool not found: ${request.toolName}`);
      } else {
        const permissionDecision = this.permissionPolicy.evaluate({
      tool,
      request: {
        ...request,
        input: normalizedInput,
      },
      mode: request.permissionMode,
      plan: request.planState,
    });
        record.permissionDecision = permissionDecision;
        if (permissionDecision.action !== "allow") {
          this.denyRecord(
            record,
            permissionDecision.reason ?? "tool execution denied by policy"
          );
        } else {
          const boundaryError = this.checkProjectBoundary(request.toolName, normalizedInput, request.projectBoundary);
          if (boundaryError) {
            this.denyRecord(record, boundaryError);
          } else {
          const pathDecision = this.sandbox?.canUseToolInputPaths(normalizedInput);
          if (pathDecision && !pathDecision.allowed) {
            this.denyRecord(
              record,
              pathDecision.reason ?? "tool input path blocked by sandbox"
            );
          } else {
            const sandboxDecision = this.sandbox?.canExecuteTool(tool);
            if (sandboxDecision && !sandboxDecision.allowed) {
              this.denyRecord(
                record,
                sandboxDecision.reason ?? "tool execution blocked by sandbox"
              );
              const endedAtMs = Date.now();
              record.endedAt = new Date(endedAtMs).toISOString();
              record.durationMs = endedAtMs - startedAtMs;
              await this.writeAudit(record);
              return record;
            }
            const mutationPreflight = this.captureMutationPreflight(
              request.sessionId,
              request.toolName,
              normalizedInput
            );
            await this.executeAllowedTool(
              record,
              {
                ...request,
                input: normalizedInput,
                args: normalizedInput,
              },
              tool
            );
            await this.afterToolExecution(record, request.sessionId, mutationPreflight);
          }
          }
        }
      }
    } catch (err) {
      this.errorRecord(
        record,
        err instanceof Error ? err.message : String(err)
      );
    }

    const endedAtMs = Date.now();
    record.endedAt = new Date(endedAtMs).toISOString();
    record.durationMs = endedAtMs - startedAtMs;
    if (record.result && record.result.durationMs === undefined) {
      record.result.durationMs = record.durationMs;
    }

    await this.writeAudit(record);

    return record;
  }

  private async executeAllowedTool(
    record: GatewayToolCallRecord,
    request: GatewayToolCallRequest,
    tool: NonNullable<ReturnType<typeof this.registry.get>>
  ): Promise<void> {
    if (isExecutionTool(request.toolName)) {
      await this.executeLocally(record, request);
      return;
    }

    await this.executeOnHost(record, request);
  }

  private captureMutationPreflight(
    sessionId: string | undefined,
    toolName: string,
    input: Record<string, unknown>
  ) {
    if (!sessionId || !isFileMutationTool(toolName)) {
      return undefined;
    }

    const filePath = resolveInputFilePath(this.projectRoot, input);
    if (!filePath) {
      return undefined;
    }

    if (fs.existsSync(filePath)) {
      this.fileAccessTracker.assertCanMutateExistingFile(sessionId, filePath);
    }

    return {
      sessionId,
      filePath,
      preflight: this.fileAccessTracker.capturePreflight(filePath),
    };
  }

  private async afterToolExecution(
    record: GatewayToolCallRecord,
    sessionId: string | undefined,
    mutationPreflight:
      | {
          sessionId: string;
          filePath: string;
          preflight: ReturnType<FileAccessTracker["capturePreflight"]>;
        }
      | undefined
  ): Promise<void> {
    if (record.status === "success" && sessionId && record.toolName === "file.read") {
      const filePath = resolveInputFilePath(this.projectRoot, record.input);
      if (filePath) {
        this.fileAccessTracker.recordRead(sessionId, filePath);
      }
    }

    if (record.status === "success" && mutationPreflight) {
      const summary = this.fileAccessTracker.finalizeMutation(
        mutationPreflight.sessionId,
        mutationPreflight.filePath,
        mutationPreflight.preflight
      );
      record.audit = {
        ...record.audit,
        fileMutation: summary as unknown as Record<string, unknown>,
      };
      record.output = {
        ...record.output,
        ok: record.output?.ok ?? true,
        metadata: {
          ...(record.output?.metadata ?? {}),
          diffSummary: summary,
        },
      };
    }

    if (isExecutionTool(record.toolName)) {
      this.normalizeExecutionRecord(record);
    }

    this.truncateLargeRecord(record);
  }

  private async executeOnHost(
    record: GatewayToolCallRecord,
    request: GatewayToolCallRequest
  ): Promise<void> {
    const tool = this.registry.get(request.toolName);
    if (!tool) {
      this.errorRecord(record, `[tools] tool not found: ${request.toolName}`);
      return;
    }

    const result = await tool.execute(request.input, {
      sessionId: request.sessionId,
      requestId: request.requestId,
    });
    this.applyToolResult(record, {
      ...result,
      toolCallId: request.id,
    });
  }

  private async executeLocally(
    record: GatewayToolCallRecord,
    request: GatewayToolCallRequest
  ): Promise<void> {
    if (process.env.GATEWAY_DISABLE_LOCAL_EXECUTION === "true") {
      this.denyRecord(
        record,
        "[local-runner] local execution is disabled by GATEWAY_DISABLE_LOCAL_EXECUTION=true"
      );
      return;
    }

    const command = resolveExecutionCommand(request.toolName, request.input);
    if (!command) {
      this.errorRecord(record, `[local-runner] no command for tool: ${request.toolName}`);
      return;
    }

    const cwd = request.projectBoundary?.commandCwd
      ?? (typeof request.input.cwd === "string" && request.input.cwd.trim() !== ""
        ? request.input.cwd
        : this.projectRoot);

    const effectiveWorkspaceRoot = request.projectBoundary?.commandCwd ?? this.projectRoot;

    const timeoutMs =
      typeof request.input.timeoutMs === "number" ? request.input.timeoutMs : undefined;

    try {
      const result = await runLocalCommand(
        { command, cwd, timeoutMs },
        effectiveWorkspaceRoot
      );

      const ok = result.exitCode === 0 && !result.timedOut;
      const toolResult: ToolResult = {
        toolCallId: request.id,
        ok,
        result: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          artifacts: [],
        },
        error: ok
          ? undefined
          : result.timedOut
            ? "local command timed out"
            : `local command failed with exit code ${result.exitCode ?? "unknown"}`,
        durationMs: result.durationMs,
      };

      record.output = {
        ok,
        content: {
          decision: "local",
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          artifacts: [],
        },
        error: toolResult.error,
        metadata: {
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          artifacts: [],
          runner: "local-windows",
        },
      };
      this.applyToolResult(record, toolResult);
    } catch (err) {
      this.denyRecord(
        record,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private applyToolResult(record: GatewayToolCallRecord, result: ToolResult): void {
    record.result = result;
    if (!record.output) {
      record.output = {
        ok: result.ok,
        content: result.result,
        error: result.error,
        metadata:
          result.durationMs === undefined
            ? undefined
            : {
                durationMs: result.durationMs,
              },
      };
    }

    if (result.ok) {
      record.status = "success";
      record.error = undefined;
      return;
    }

    record.status = "error";
    record.error = result.error ?? "tool invocation failed";
  }

  private errorRecord(
    record: GatewayToolCallRecord,
    error: string,
    metadata?: Record<string, unknown>
  ): void {
    record.status = "error";
    record.error = error;
    record.result = {
      toolCallId: record.id,
      ok: false,
      error,
    };
    record.output = {
      ok: false,
      error,
      metadata,
    };
  }

  private denyRecord(
    record: GatewayToolCallRecord,
    error: string,
    metadata?: Record<string, unknown>
  ): void {
    record.status = "denied";
    record.error = error;
    record.result = {
      toolCallId: record.id,
      ok: false,
      error,
    };
    record.output = {
      ok: false,
      error,
      metadata,
    };
  }

  private truncateLargeRecord(record: GatewayToolCallRecord): void {
    if (isExecutionTool(record.toolName)) {
      return;
    }

    const payload = {
      output: record.output,
      result: record.result?.result,
    };
    const serialized = safeStringify(payload);
    if (!serialized || serialized.length <= MAX_INLINE_RESULT_CHARS) {
      return;
    }

    fs.mkdirSync(this.toolResultDir, { recursive: true });
    const artifactPath = path.join(this.toolResultDir, `${record.id}.json`);
    fs.writeFileSync(artifactPath, `${serialized}\n`, "utf8");

    const summary = {
      summary: "tool result truncated",
      artifactPath,
      originalChars: serialized.length,
    };

    if (record.result) {
      record.result.result = summary;
    }
    record.output = {
      ok: record.output?.ok ?? record.result?.ok ?? false,
      content: summary,
      error: record.output?.error,
      metadata: {
        ...(record.output?.metadata ?? {}),
        truncated: true,
        artifactPath,
      },
    };
    record.audit = {
      ...record.audit,
      truncated: true,
      artifactPath,
    };
  }

  private normalizeExecutionRecord(record: GatewayToolCallRecord): void {
    const raw = extractExecutionPayload(record);
    if (!raw) {
      return;
    }

    const combinedLength = raw.stdout.length + raw.stderr.length;
    let fullOutputPath: string | undefined;

    if (combinedLength > MAX_INLINE_RESULT_CHARS) {
      fs.mkdirSync(this.toolResultDir, { recursive: true });
      fullOutputPath = path.join(this.toolResultDir, `${record.id}.log.json`);
      fs.writeFileSync(
        fullOutputPath,
        `${JSON.stringify(
          {
            toolName: record.toolName,
            exitCode: raw.exitCode,
            timedOut: raw.timedOut,
            stdout: raw.stdout,
            stderr: raw.stderr,
            artifacts: raw.artifacts,
          },
          null,
          2
        )}\n`,
        "utf8"
      );
    }

    const summary = raw.ok
      ? {
          ok: true,
          exitCode: raw.exitCode,
          stdoutPreview: truncatePreview(raw.stdout),
          stderrPreview: truncatePreview(raw.stderr),
          durationMs: raw.durationMs,
          timedOut: raw.timedOut,
          fullOutputPath,
          artifacts: raw.artifacts,
        }
      : {
          ok: false,
          exitCode: raw.exitCode,
          error:
            record.error ??
            (raw.timedOut
              ? "command timed out"
              : `command failed with exit code ${raw.exitCode ?? "unknown"}`),
          stdoutPreview: truncatePreview(raw.stdout),
          stderrPreview: truncatePreview(raw.stderr),
          durationMs: raw.durationMs,
          timedOut: raw.timedOut,
          fullOutputPath,
          artifacts: raw.artifacts,
        };

    if (record.result) {
      record.result.result = summary;
    }
    record.output = {
      ok: record.output?.ok ?? record.result?.ok ?? false,
      content: summary,
      error: record.output?.error ?? record.error,
      metadata: {
        ...(record.output?.metadata ?? {}),
        exitCode: raw.exitCode,
        timedOut: raw.timedOut,
        fullOutputPath,
        artifacts: raw.artifacts,
      },
    };
    record.audit = {
      ...record.audit,
      truncated: Boolean(fullOutputPath),
      artifactPath: fullOutputPath ?? record.audit?.artifactPath,
      execution: {
        exitCode: raw.exitCode,
        timedOut: raw.timedOut,
        cwd:
          typeof record.input.cwd === "string" && record.input.cwd.trim() !== ""
            ? record.input.cwd
            : this.projectRoot,
        sandboxed: false,
        runner: "local-windows",
        fullOutputPath,
      } as unknown as Record<string, unknown>,
    };
  }

  private async writeAudit(record: GatewayToolCallRecord): Promise<void> {
    if (!this.auditLogger) {
      return;
    }

    const logger = this.auditLogger as {
      log?: (event: unknown) => Promise<void> | void;
      record?: (event: unknown) => Promise<void> | void;
      append?: (event: unknown) => Promise<void> | void;
      write?: (event: unknown) => Promise<void> | void;
    };

    const type =
      record.status === "success"
        ? "gateway.tool_call.completed"
        : record.status === "denied"
          ? "gateway.tool_call.denied"
          : "gateway.tool_call.failed";

    const event = {
      type,
      timestamp: new Date().toISOString(),
      toolCallId: record.id,
      toolName: record.toolName,
      riskLevel: record.riskLevel,
      permissionLevel: record.permissionLevel,
      permissionMode: record.permissionMode,
      sessionId: record.sessionId,
      requestId: record.requestId,
      status: record.status,
      durationMs: record.durationMs,
      ok: record.output?.ok ?? false,
      error: record.error,
      decision: record.permissionDecision,
      audit: record.audit,
      cwd:
        typeof record.input.cwd === "string" && record.input.cwd.trim() !== ""
          ? record.input.cwd
          : undefined,
      sandboxed: false,
      runner: "local-windows",
      exitCode: readExecutionMetadataNumber(record.output?.metadata?.exitCode),
      timedOut: record.output?.metadata?.timedOut === true,
      artifacts: Array.isArray(record.output?.metadata?.artifacts)
        ? record.output?.metadata?.artifacts
        : undefined,
      runId: undefined as string | undefined,
      subRunId: undefined as string | undefined,
      agentName: undefined as string | undefined,
      node: undefined as string | undefined,
      policyDecision: undefined as string | undefined,
    };

    try {
      if (typeof logger.log === "function") {
        await logger.log(event);
        return;
      }
      if (typeof logger.record === "function") {
        await logger.record(event);
        return;
      }
      if (typeof logger.append === "function") {
        await logger.append(event);
        return;
      }
      if (typeof logger.write === "function") {
        await logger.write(event);
      }
    } catch {
      // audit logging must not break tool execution
    }
  }

  private checkProjectBoundary(
    toolName: string,
    input: Record<string, unknown>,
    boundary: GatewayProjectBoundary | undefined
  ): string | undefined {
    if (!boundary) {
      return undefined;
    }

    const isFileTool =
      toolName === "file.read" ||
      toolName === "file.write" ||
      toolName === "file.edit";
    const isShellTool =
      toolName === "shell.run" ||
      toolName === "bash.run" ||
      toolName === "run_test" ||
      toolName === "npm_test" ||
      toolName === "build";

    if (!isFileTool && !isShellTool) {
      return undefined;
    }

    if (boundary.permission === "chat-only" || !boundary.projectDir) {
      return `当前 session 未绑定 projectDir，${toolName} 工具不可用。请先使用 :bind <projectDir> 绑定项目目录。`;
    }

    if (isShellTool) {
      const command = typeof input.command === "string" ? input.command.trim() : "";
      if (command) {
        const dangerousPattern = detectDangerousShellCommand(command);
        if (dangerousPattern) {
          return `shell 命令包含危险操作（${dangerousPattern}），已拒绝。shell 只能在 projectDir 内执行安全操作。`;
        }
      }
      return undefined;
    }

    const rawPath = typeof input.path === "string" ? input.path : undefined;
    if (!rawPath) {
      return undefined;
    }

    if (isSessionMemoryFile(rawPath)) {
      return `文件 ${rawPath} 是 session 内部记忆文件，只能由 SessionMemoryManager 写入，不允许通过工具修改。`;
    }

    if (path.isAbsolute(rawPath)) {
      const resolved = path.resolve(rawPath);
      const isReadOnlyTool = toolName === "file.read";
      const isWritableTool = toolName === "file.write" || toolName === "file.edit";

      const isReadable = boundary.allowedReadRoots.some((root) =>
        isPathUnderRoot(resolved, root)
      );

      if (isWritableTool) {
        if (!isReadable) {
          return `文件路径 ${rawPath} 不在允许读取的目录范围内。`;
        }
        const isWritable = boundary.allowedWriteRoots.some((root) =>
          isPathUnderRoot(resolved, root)
        );
        if (!isWritable) {
          return `文件路径 ${rawPath} 不在允许写入的目录范围内。`;
        }
        return undefined;
      }

      if (isReadable) {
        return undefined;
      }

      if (isReadOnlyTool) {
        if (isSensitivePath(resolved)) {
          return `文件路径 ${rawPath} 指向敏感系统目录，禁止读取。`;
        }
        return undefined;
      }

      return `文件路径 ${rawPath} 不在允许读取的目录范围内。`;
    }

    const resolved = path.resolve(boundary.projectDir, rawPath);
    const normalizedProjectDir = path.resolve(boundary.projectDir);
    if (!isPathUnderRoot(resolved, normalizedProjectDir)) {
      return `文件路径 ${rawPath} 试图逃出项目目录，已拒绝。`;
    }

    const isReadable = boundary.allowedReadRoots.some((root) =>
      isPathUnderRoot(resolved, root)
    );
    if (!isReadable) {
      return `文件路径 ${rawPath} 解析后不在允许读取的目录范围内。`;
    }

    if (toolName === "file.write" || toolName === "file.edit") {
      const isWritable = boundary.allowedWriteRoots.some((root) =>
        isPathUnderRoot(resolved, root)
      );
      if (!isWritable) {
        return `文件路径 ${rawPath} 解析后不在允许写入的目录范围内。`;
      }
    }

    return undefined;
  }
}

function isPathUnderRoot(filePath: string, root: string): boolean {
  const normalizedFile = path.resolve(filePath).toLowerCase().replace(/\//g, "\\");
  const normalizedRoot = path.resolve(root).toLowerCase().replace(/\//g, "\\");
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(normalizedRoot + "\\");
}

const SENSITIVE_PATH_PATTERNS = [
  "\\.ssh",
  "\\appdata",
  "\\programdata",
  "\\$recycle.bin",
  "\\system volume information",
  "cookies",
  "\\local state",
  "\\login data",
];

function isSensitivePath(resolvedPath: string): boolean {
  const normalized = resolvedPath.toLowerCase().replace(/\//g, "\\");
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (normalized.includes(pattern)) {
      return true;
    }
  }
  const windowsUsersPattern = /^[a-z]:\\users\\/i;
  if (windowsUsersPattern.test(normalized)) {
    return true;
  }
  const systemRoot = process.env.SystemRoot?.toLowerCase() ?? "c:\\windows";
  if (normalized.startsWith(systemRoot + "\\") || normalized === systemRoot) {
    return true;
  }
  return false;
}

const SESSION_MEMORY_FILENAMES = [
  "working-memory.json",
  "rolling-summary.md",
  "open-issues.json",
  "decisions.jsonl",
];

function isSessionMemoryFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replace(/\//g, "\\");
  return SESSION_MEMORY_FILENAMES.some((name) => normalized.endsWith("\\" + name));
}

const DANGEROUS_SHELL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bcd\s+[.]{2}\s*$/i, label: "cd .. 目录逃逸" },
  { pattern: /\bcd\s+\\\s*$/i, label: "cd \\ 切换根目录" },
  { pattern: /\bcd\s+[a-z]:\\/i, label: "cd 切换到其他磁盘" },
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|--recursive)\b/i, label: "rm -rf 递归删除" },
  { pattern: /\bdel\s+\/s\b/i, label: "del /s 递归删除" },
  { pattern: /\brmdir\s+\/s\b/i, label: "rmdir /s 递归删除" },
  { pattern: /\bformat\s+[a-z]:/i, label: "format 磁盘格式化" },
  { pattern: /\bpowershell\s+-[eE]ncoded[cC]ommand\b/i, label: "EncodedCommand 编码执行" },
  { pattern: /\bcurl\s.*\|\s*(ba)?sh\b/i, label: "curl | sh 管道执行" },
  { pattern: /\bwget\s.*\|\s*(ba)?sh\b/i, label: "wget | sh 管道执行" },
];

function detectDangerousShellCommand(command: string): string | null {
  const firstLine = command.split(/[;&|]+/)[0]?.trim() ?? command;
  for (const { pattern, label } of DANGEROUS_SHELL_PATTERNS) {
    if (pattern.test(firstLine) || pattern.test(command)) {
      return label;
    }
  }
  return null;
}

function resolveExecutionCommand(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  switch (toolName) {
    case "shell.run":
    case "bash.run":
      return typeof input.command === "string" && input.command.trim() !== ""
        ? input.command
        : undefined;
    case "run_test":
      return typeof input.command === "string" && input.command.trim() !== ""
        ? input.command
        : "npm test";
    case "npm_test":
      return typeof input.command === "string" && input.command.trim() !== ""
        ? input.command
        : "npm test";
    case "build":
      return "npm run build";
    default:
      return undefined;
  }
}

function normalizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
  projectRoot: string
): Record<string, unknown> {
  if (
    toolName !== "shell.run" &&
    toolName !== "bash.run" &&
    toolName !== "run_test" &&
    toolName !== "npm_test" &&
    toolName !== "build"
  ) {
    return input;
  }
  const cwd = normalizeShellCwd(input.cwd, projectRoot);

  return {
    ...input,
    cwd,
  };
}

function normalizeShellCwd(input: unknown, projectRoot: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    return projectRoot;
  }

  const trimmed = input.trim();
  if (trimmed === "/workspace") {
    return projectRoot;
  }

  if (trimmed.startsWith("/workspace/")) {
    const relative = trimmed.slice("/workspace/".length).replace(/\//g, "\\");
    return `${projectRoot}\\${relative}`;
  }

  return trimmed;
}

function isFileMutationTool(toolName: string): boolean {
  return toolName === "file.write" || toolName === "file.edit";
}

function resolveInputFilePath(
  projectRoot: string,
  input: Record<string, unknown>
): string | undefined {
  if (typeof input.path !== "string" || input.path.trim() === "") {
    return undefined;
  }

  return path.resolve(projectRoot, input.path);
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function isExecutionTool(toolName: string): boolean {
  return (
    toolName === "shell.run" ||
    toolName === "bash.run" ||
    toolName === "run_test" ||
    toolName === "npm_test" ||
    toolName === "build"
  );
}

function extractExecutionPayload(record: GatewayToolCallRecord):
  | {
      ok: boolean;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      durationMs: number;
      timedOut: boolean;
      artifacts: Array<{
        path: string;
        sizeBytes?: number;
        kind?: string;
        description?: string;
      }>;
    }
  | undefined {
  const outputContent =
    record.output?.content && typeof record.output.content === "object"
      ? (record.output.content as Record<string, unknown>)
      : undefined;
  const resultContent =
    record.result?.result && typeof record.result.result === "object"
      ? (record.result.result as Record<string, unknown>)
      : undefined;
  const source = outputContent ?? resultContent;
  if (!source) {
    return undefined;
  }

  const stdout = typeof source.stdout === "string" ? source.stdout : "";
  const stderr = typeof source.stderr === "string" ? source.stderr : "";
  const exitCode =
    typeof source.exitCode === "number" || source.exitCode === null
      ? (source.exitCode as number | null)
      : null;
  const timedOut = source.timedOut === true;
  const artifacts = Array.isArray(source.artifacts)
    ? source.artifacts.flatMap((artifact) => {
        if (!artifact || typeof artifact !== "object") {
          return [];
        }
        const candidate = artifact as Record<string, unknown>;
        return typeof candidate.path === "string"
          ? [
              {
                path: candidate.path,
                sizeBytes:
                  typeof candidate.sizeBytes === "number"
                    ? candidate.sizeBytes
                    : undefined,
                kind:
                  typeof candidate.kind === "string"
                    ? candidate.kind
                    : undefined,
                description:
                  typeof candidate.description === "string"
                    ? candidate.description
                    : undefined,
              },
            ]
          : [];
      })
    : [];

  return {
    ok: record.result?.ok ?? record.output?.ok ?? false,
    exitCode,
    stdout,
    stderr,
    durationMs:
      record.result?.durationMs ??
      (typeof record.output?.metadata?.durationMs === "number"
        ? record.output.metadata.durationMs
        : record.durationMs ?? 0),
    timedOut,
    artifacts,
  };
}

function truncatePreview(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length <= EXECUTION_PREVIEW_CHARS) {
    return trimmed;
  }

  return `${trimmed.slice(0, EXECUTION_PREVIEW_CHARS)}...[truncated]`;
}

function readExecutionMetadataNumber(value: unknown): number | null | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value === null) {
    return null;
  }

  return undefined;
}
