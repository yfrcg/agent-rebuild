import {
  decideToolExecution,
  resolveToolSecurityProfile,
} from "../sandbox/src/policy";
import type {
  SandboxResult,
  ToolSecurityProfile,
} from "../sandbox/src/types";
import type {
  GatewayToolCallExecutorOptions,
  GatewayToolCallRecord,
  GatewayToolCallRequest,
} from "./toolCallTypes";
import type { GatewayToolOutput } from "./toolTypes";

export class ToolCallExecutor {
  private readonly registry: GatewayToolCallExecutorOptions["registry"];
  private readonly auditLogger?: unknown;
  private readonly sandbox?: GatewayToolCallExecutorOptions["sandbox"];

  constructor(options: GatewayToolCallExecutorOptions) {
    this.registry = options.registry;
    this.auditLogger = options.auditLogger;
    this.sandbox = options.sandbox;
  }

  async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
    const record: GatewayToolCallRecord = {
      id: request.id,
      toolName: request.toolName,
      input: request.input,
      status: "pending",
      sessionId: request.sessionId,
      requestId: request.requestId,
      createdAt: request.createdAt,
    };

    const startedAtMs = Date.now();
    record.startedAt = new Date(startedAtMs).toISOString();
    record.status = "running";

    try {
      const tool = this.registry.get(request.toolName);
      const pathDecision = this.sandbox?.canUseToolInputPaths(request.input);
      if (pathDecision && !pathDecision.allowed) {
        this.failRecord(record, pathDecision.reason ?? "tool input path blocked by sandbox");
      } else {
        const security = this.sandbox?.getToolSecurityProfile(tool) ??
          resolveToolSecurityProfile({
            security: tool?.security,
            legacyPolicy: tool?.policy,
          });
        const executionDecision = decideToolExecution({
          profile: security,
          hasSandboxSpec: Boolean(tool?.sandboxSpec),
          approved: request.approved,
        });

        if (!tool?.sandboxSpec) {
          const legacyDecision = this.sandbox?.canExecuteTool(tool);
          if (legacyDecision && !legacyDecision.allowed) {
            this.failRecord(
              record,
              legacyDecision.reason ?? "tool execution blocked by legacy sandbox policy"
            );
          } else {
            await this.executeByDecision(record, request, executionDecision);
          }
        } else {
          await this.executeByDecision(record, request, executionDecision);
        }
      }
    } catch (err) {
      record.status = "failed";
      record.error = err instanceof Error ? err.message : String(err);
      record.output = {
        ok: false,
        error: record.error,
      };
    }

    const completedAtMs = Date.now();
    record.completedAt = new Date(completedAtMs).toISOString();
    record.durationMs = completedAtMs - startedAtMs;

    await this.writeAudit(record);

    return record;
  }

  private async executeByDecision(
    record: GatewayToolCallRecord,
    request: GatewayToolCallRequest,
    decision: ReturnType<typeof decideToolExecution>
  ): Promise<void> {
    switch (decision.action) {
      case "blocked":
        this.failRecord(record, decision.reason ?? "tool execution blocked by policy");
        return;
      case "requireApproval":
        this.failRecord(record, decision.reason ?? "tool execution requires approval", {
          reason: "requireApproval",
          riskLevel: decision.profile.riskLevel,
        });
        return;
      case "sandbox":
        await this.executeInSandbox(record, request, decision.profile);
        return;
      case "host":
        await this.executeOnHost(record, request);
        return;
    }
  }

  private async executeOnHost(
    record: GatewayToolCallRecord,
    request: GatewayToolCallRequest
  ): Promise<void> {
    const output = await this.registry.invoke(request.toolName, request.input, {
      sessionId: request.sessionId,
      requestId: request.requestId,
    });

    record.output = output;
    if (output.ok) {
      record.status = "succeeded";
    } else {
      record.status = "failed";
      record.error = output.error ?? "tool invocation failed";
    }
  }

  private async executeInSandbox(
    record: GatewayToolCallRecord,
    request: GatewayToolCallRequest,
    profile: ToolSecurityProfile
  ): Promise<void> {
    const tool = this.registry.get(request.toolName);
    if (!tool?.sandboxSpec || !this.sandbox) {
      this.failRecord(record, "sandbox execution requested but no sandbox manager is configured");
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
      profileName: sandboxRequest.profileName ?? "safe-dev",
    });

    record.output = sandboxResultToToolOutput(result);
    if (result.ok) {
      record.status = "succeeded";
    } else {
      record.status = "failed";
      record.error =
        result.deniedReason ?? `sandboxed tool failed with exit code ${result.exitCode ?? "unknown"}`;
    }
  }

  private failRecord(
    record: GatewayToolCallRecord,
    error: string,
    metadata?: Record<string, unknown>
  ): void {
    record.status = "failed";
    record.error = error;
    record.output = {
      ok: false,
      error,
      metadata,
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
      record.status === "succeeded"
        ? "gateway.tool_call.completed"
        : "gateway.tool_call.failed";

    const event = {
      type,
      timestamp: new Date().toISOString(),
      toolCallId: record.id,
      toolName: record.toolName,
      sessionId: record.sessionId,
      requestId: record.requestId,
      status: record.status,
      durationMs: record.durationMs,
      ok: record.output?.ok ?? false,
      error: record.error,
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
      timedOut: result.exitCode === null && !result.deniedReason,
      artifacts: [],
    },
    error: result.deniedReason,
    metadata: {
      durationMs: result.durationMs,
    },
  };
}
