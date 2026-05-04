import * as fs from "node:fs";
import * as path from "node:path";

import {
  decideToolExecution,
  resolveToolSecurityProfile,
} from "../sandbox/src/policy";
import type {
  SandboxResult,
  ToolSecurityProfile,
} from "../sandbox/src/types";
import { resolveProjectRoot } from "../core/src/config";
import { FileAccessTracker } from "./fileAccessTracker";
import { PermissionPolicy } from "./permissionPolicy";
import type {
  GatewayToolCallExecutorOptions,
  GatewayToolCallRecord,
  GatewayToolCallRequest,
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
    });
    this.fileAccessTracker = new FileAccessTracker();
    this.toolResultDir = path.resolve(process.cwd(), "logs", "tool-results");
  }

  async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
    const normalizedInput = normalizeToolInput(
      request.toolName,
      request.input,
      this.projectRoot
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
    const security =
      this.sandbox?.getToolSecurityProfile(tool) ??
      resolveToolSecurityProfile({
        security: tool.security,
        legacyPolicy: tool.policy,
      });
    const executionDecision = decideToolExecution({
      profile: security,
      hasSandboxSpec: Boolean(tool.sandboxSpec),
      approved: request.approved,
    });

    switch (executionDecision.action) {
      case "blocked":
        this.denyRecord(
          record,
          executionDecision.reason ?? "tool execution blocked by policy"
        );
        return;
      case "requireApproval":
        this.denyRecord(
          record,
          executionDecision.reason ?? "tool execution requires approval"
        );
        return;
      case "sandbox":
        if (!tool.sandboxSpec || !this.sandbox) {
          this.denyRecord(
            record,
            "Sandbox unavailable: refusing to execute command on host. Start the WSL sandbox worker or enable explicit local dev fallback."
          );
          return;
        }
        await this.executeInSandbox(record, request, security);
        return;
      case "host":
        if (tool.requiresSandbox) {
          this.denyRecord(
            record,
            "tool requires sandbox execution and host fallback is disabled"
          );
          return;
        }
        await this.executeOnHost(record, request);
        return;
    }
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

  private async executeInSandbox(
    record: GatewayToolCallRecord,
    request: GatewayToolCallRequest,
    profile: ToolSecurityProfile
  ): Promise<void> {
    const tool = this.registry.get(request.toolName);
    if (!tool?.sandboxSpec || !this.sandbox) {
      this.denyRecord(
        record,
        "Sandbox unavailable: refusing to execute command on host. Start the WSL sandbox worker or enable explicit local dev fallback."
      );
      return;
    }

    const sandboxRequest = tool.sandboxSpec.resolve(request.input, {
      sessionId: request.sessionId,
      requestId: request.requestId,
    });
    const result = await this.sandbox.manager.exec({
      ...sandboxRequest,
      sessionId: request.sessionId ?? "gateway-session",
      toolName: request.toolName,
      profileName: sandboxRequest.profileName ?? resolveSandboxProfileName(profile),
    });

    const toolResult = sandboxResultToToolResult(request.id, result);
    record.output = sandboxResultToToolOutput(result);
    this.applyToolResult(record, toolResult);
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
              ? "sandbox command timed out"
              : `sandbox command failed with exit code ${raw.exitCode ?? "unknown"}`),
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
        sandboxed: true,
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
      sandboxed: isExecutionTool(record.toolName),
      exitCode: readExecutionMetadataNumber(record.output?.metadata?.exitCode),
      timedOut: record.output?.metadata?.timedOut === true,
      artifacts: Array.isArray(record.output?.metadata?.artifacts)
        ? record.output?.metadata?.artifacts
        : undefined,
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
}

function sandboxResultToToolOutput(result: SandboxResult): GatewayToolOutput {
  return {
    ok: result.ok,
    content: {
      decision: result.deniedReason ? "denied" : "sandbox",
      blockedReason: result.deniedReason,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true || (result.exitCode === null && !result.deniedReason),
      artifacts: result.artifacts ?? [],
    },
    error: result.deniedReason,
    metadata: {
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true || (result.exitCode === null && !result.deniedReason),
      artifacts: result.artifacts ?? [],
    },
  };
}

function sandboxResultToToolResult(toolCallId: string, result: SandboxResult): ToolResult {
  return {
    toolCallId,
    ok: result.ok,
    result: {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      deniedReason: result.deniedReason,
      timedOut: result.timedOut === true || (result.exitCode === null && !result.deniedReason),
      artifacts: result.artifacts ?? [],
    },
    error:
      result.ok
        ? undefined
        : result.deniedReason ??
          (result.stderr.trim() ||
            `sandboxed tool failed with exit code ${result.exitCode ?? "unknown"}`),
    durationMs: result.durationMs,
  };
}

function resolveSandboxProfileName(profile: ToolSecurityProfile): string {
  return profile.allowNetwork ? "elevated" : "safe-dev";
}

function normalizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
  projectRoot: string
): Record<string, unknown> {
  if (
    toolName !== "shell.run" &&
    toolName !== "bash.run" &&
    toolName !== "sandbox.exec" &&
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
    toolName === "sandbox.exec" ||
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
