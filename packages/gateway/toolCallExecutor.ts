import type {
  GatewayToolCallExecutorOptions,
  GatewayToolCallRecord,
  GatewayToolCallRequest,
} from "./toolCallTypes";

export class ToolCallExecutor {
  private readonly registry: GatewayToolCallExecutorOptions["registry"];
  private readonly auditLogger?: unknown;

  constructor(options: GatewayToolCallExecutorOptions) {
    this.registry = options.registry;
    this.auditLogger = options.auditLogger;
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
      const output = await this.registry.invoke(
        request.toolName,
        request.input,
        {
          sessionId: request.sessionId,
          requestId: request.requestId,
        }
      );

      record.output = output;
      if (output.ok) {
        record.status = "succeeded";
      } else {
        record.status = "failed";
        record.error = output.error ?? "tool invocation failed";
      }
    } catch (err) {
      record.status = "failed";
      record.error = err instanceof Error ? err.message : String(err);
    }

    const completedAtMs = Date.now();
    record.completedAt = new Date(completedAtMs).toISOString();
    record.durationMs = completedAtMs - startedAtMs;

    await this.writeAudit(record);

    return record;
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
      // Audit failure must never affect tool call execution.
    }
  }
}
