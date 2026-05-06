
import { readTranscript } from "../../session/src/transcript";
import { readAuditTail } from "./auditTail";
import { createGatewayRequest } from "../requestHandler";
import { extractProjectBoundary } from "../sessionTypes";
import { createGatewayToolCallRequest } from "../toolCallFactory";
import type { GatewayToolCallRecord } from "../toolCallTypes";
import type { GatewayRuntime } from "../runtime";
import type { ConnectionManager, WsClientConnection } from "./connectionManager";
import type { GatewayWsAuthConfig } from "./auth";
import type { GatewayWsMetricsCollector } from "./metrics";
import { writeGatewayWsMemory } from "./memoryWrite";
import type { IdempotencyRecord, IdempotencyStore } from "./idempotencyStore";
import {
  fail,
  GATEWAY_WS_PROTOCOL_VERSION,
  ok,
  type WsRequest,
  type WsResponse,
} from "./protocol";
import type { RunManager } from "./runManager";
import { validateWsRequestParams } from "./schemas";

/**
 * WS 路由处理所需的共享上下文。
 *
 * 这里把 Gateway 运行时、连接管理、运行任务、幂等存储和指标收集集中传入，
 * 让单个方法处理函数保持无状态，便于测试时替换依赖。
 */
export interface WsRouterContext {
  runtime: GatewayRuntime;
  connections: ConnectionManager;
  runs: RunManager;
  idempotency: IdempotencyStore;
  metrics?: GatewayWsMetricsCollector;
  limits?: Pick<
    GatewayWsAuthConfig,
    "maxRunsPerClient" | "maxRunsTotal" | "deltaBatchMs"
  >;
}

/**
 * 分发并处理单个 WebSocket 请求。
 *
 * 函数会先做方法级参数校验，再按 `request.method` 进入具体处理器。
 * 返回 `void` 的情况表示请求已经被转换成异步任务，后续结果通过事件推送。
 */
export async function handleWsRequest(
  client: WsClientConnection,
  request: WsRequest,
  context: WsRouterContext
): Promise<WsResponse | void> {
  context.connections.markSeen(client.clientId);
  const schema = validateWsRequestParams(request);
  if (!schema.ok) {
    return fail(request.id, schema.code, schema.message, schema.details);
  }

  switch (request.method) {
    case "connect":
      return handleConnect(client, request, context);
    case "ping":
      return ok(request.id, { pong: true, serverTime: new Date().toISOString() });
    case "runtime.status":
      return ok(request.id, getRuntimeStatus(context));
    case "session.list":
      return ok(request.id, context.runtime.sessionManager.listSessions());
    case "session.get":
      return handleSessionGet(request, context);
    case "session.create":
      return handleSessionCreate(request, context);
    case "session.rename":
      return handleSessionRename(request, context);
    case "session.bindProject":
      return handleSessionBindProject(request, context);
    case "session.getTranscript":
      return handleSessionGetTranscript(request, context);
    case "chat.send":
      return handleChatSend(client, request, context);
    case "chat.cancel":
      return handleChatCancel(request, context);
    case "memory.search":
      return handleMemorySearch(request, context);
    case "memory.write":
      return handleMemoryWrite(request, context);
    case "tool.list":
      return ok(request.id, context.runtime.toolRegistry.list());
    case "tool.call":
      return handleToolCall(request, context);
    case "approval.list":
      return handleApprovalList(request, context);
    case "approval.confirm":
      return handleApprovalConfirm(request, context);
    case "approval.reject":
      return handleApprovalReject(request, context);
    case "audit.tail":
      return handleAuditTail(request, context);
  }

  return fail(request.id, "NOT_IMPLEMENTED", `Unsupported WebSocket method: ${request.method}`);
}

/**
 * 处理连接握手。
 *
 * 握手会确认主版本兼容、发送 connected 事件，并在客户端提供 resume 参数时
 * 尝试补发会话事件；如果回放历史缺失，会要求客户端做完整状态重同步。
 */
function handleConnect(
  client: WsClientConnection,
  request: WsRequest,
  context: WsRouterContext
): WsResponse {
  const params = asRecord(request.params);
  const protocolVersion = typeof params?.protocolVersion === "string"
    ? params.protocolVersion
    : GATEWAY_WS_PROTOCOL_VERSION;
  if (protocolVersion.split(".")[0] !== GATEWAY_WS_PROTOCOL_VERSION.split(".")[0]) {
    return fail(request.id, "BAD_REQUEST", `Unsupported protocolVersion: ${protocolVersion}`);
  }

  context.connections.sendEvent(client.clientId, {
    type: "event",
    event: "connected",
    payload: {
      clientId: client.clientId,
      serverTime: new Date().toISOString(),
    },
  });

  const resume = asRecord(params?.resume);
  if (resume) {
    const sessionId = String(resume.sessionId);
    context.connections.subscribe(client.clientId, sessionId);
    const replayed = context.connections.replaySessionEvents(
      client.clientId,
      sessionId,
      Number(resume.lastSeq)
    );
    if (!replayed) {
      context.connections.sendEvent(client.clientId, {
        type: "event",
        event: "state.resync_required",
        sessionId,
        payload: { reason: "Replay buffer no longer contains this session history." },
      });
    }
  }

  return ok(request.id, {
    clientId: client.clientId,
    protocolVersion: GATEWAY_WS_PROTOCOL_VERSION,
    serverVersion: "1.0.0",
    serverTime: new Date().toISOString(),
    capabilities: {
      eventReplay: true,
      toolApproval: true,
      pseudoStreaming: true,
      trueStreaming: Boolean(context.runtime.modelProvider.supportsStreaming ?? false),
      cancellation: true,
      auditTail: true,
      memoryWrite: true,
    },
  });
}

/** 汇总当前 Gateway 和 WS 层运行状态，供客户端健康检查面板展示。 */
function getRuntimeStatus(context: WsRouterContext): Record<string, unknown> {
  return {
    model: context.runtime.config.model,
    debug: context.runtime.config.debug,
    sandboxMode: context.runtime.config.sandboxMode,
    toolCount: context.runtime.toolRegistry.list().length,
    sessionCount: context.runtime.sessionManager.listSessions().length,
    currentSessionId: context.runtime.sessionManager.getCurrentSessionId(),
    metrics: context.runtime.metricsCollector.snapshot("closed"),
    wsMetrics: context.metrics?.snapshot(),
  };
}

/** 读取指定会话；未传 sessionId 时回落到当前会话。 */
function handleSessionGet(request: WsRequest, context: WsRouterContext): WsResponse {
  const params = asRecord(request.params);
  const sessionId = typeof params?.sessionId === "string"
    ? params.sessionId
    : context.runtime.sessionManager.getCurrentSessionId();
  const session = findSession(context.runtime, sessionId);
  return session
    ? ok(request.id, session)
    : fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);
}

/** 创建会话，并通过幂等键避免客户端重试时重复创建。 */
function handleSessionCreate(request: WsRequest, context: WsRouterContext): WsResponse {
  const existing = checkIdempotency(request, context.idempotency);
  if (existing) return idempotencyResponse(request.id, existing);
  const name = typeof asRecord(request.params)?.name === "string"
    ? String(asRecord(request.params)?.name)
    : undefined;
  const session = context.runtime.sessionManager.createSession(name);
  completeIdempotency(request, context.idempotency, session);
  context.connections.broadcastToSession(session.id, {
    type: "event",
    event: "session.updated",
    sessionId: session.id,
    payload: session,
  });
  return ok(request.id, session);
}

/** 重命名会话；v1 只允许操作当前会话，避免跨会话状态写入复杂化。 */
function handleSessionRename(request: WsRequest, context: WsRouterContext): WsResponse {
  const params = asRecord(request.params);
  const currentSessionId = context.runtime.sessionManager.getCurrentSessionId();
  const targetSessionId = typeof params?.sessionId === "string" ? params.sessionId : currentSessionId;
  if (targetSessionId !== currentSessionId) {
    return fail(request.id, "NOT_IMPLEMENTED", "session.rename v1 only supports the current session.");
  }
  const session = context.runtime.sessionManager.renameCurrentSession(String(params?.name));
  context.connections.broadcastToSession(session.id, {
    type: "event",
    event: "session.updated",
    sessionId: session.id,
    payload: session,
  });
  return ok(request.id, session);
}

/**
 * 将会话绑定到项目目录。
 *
 * 绑定逻辑复用 SessionManager 的沙箱根校验，失败时根据错误语义转换成
 * `FORBIDDEN` 或 `BAD_REQUEST`，并同步更新幂等记录。
 */
function handleSessionBindProject(request: WsRequest, context: WsRouterContext): WsResponse {
  const existing = checkIdempotency(request, context.idempotency);
  if (existing) return idempotencyResponse(request.id, existing);
  const params = asRecord(request.params)!;
  try {
    const payload = context.runtime.sessionManager.bindProjectDir(
      String(params.sessionId),
      String(params.projectDir),
      context.runtime.config.sandboxAllowedRoots,
      "ws"
    );
    completeIdempotency(request, context.idempotency, payload);
    context.connections.broadcastToSession(String(params.sessionId), {
      type: "event",
      event: "session.updated",
      sessionId: String(params.sessionId),
      payload: payload.session,
    });
    return ok(request.id, payload);
  } catch (err) {
    const message = toErrorMessage(err);
    failIdempotency(request, context.idempotency, message);
    return fail(request.id, message.includes("allowed roots") ? "FORBIDDEN" : "BAD_REQUEST", message);
  }
}

/** 读取会话 transcript；不存在的会话直接返回 NOT_FOUND。 */
function handleSessionGetTranscript(request: WsRequest, context: WsRouterContext): WsResponse {
  const sessionId = String(asRecord(request.params)?.sessionId);
  if (!findSession(context.runtime, sessionId)) {
    return fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);
  }
  return ok(request.id, readTranscript(sessionId));
}

/**
 * 创建一次异步聊天运行任务。
 *
 * 同步响应只返回 runId；真正的模型输出、工具事件和最终结果会由
 * `executeChatRun()` 后续广播给订阅该会话的所有客户端。
 */
function handleChatSend(
  client: WsClientConnection,
  request: WsRequest,
  context: WsRouterContext
): WsResponse {
  const existing = checkIdempotency(request, context.idempotency);
  if (existing) return idempotencyResponse(request.id, existing);

  const params = asRecord(request.params)!;
  const sessionId = String(params.sessionId);
  const input = String(params.input).trim();
  const session = findSession(context.runtime, sessionId);
  if (!session) {
    return fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);
  }
  if (context.runs.countRunning({ clientId: client.clientId }) >= (context.limits?.maxRunsPerClient ?? 2)) {
    context.metrics?.rateLimitedRequest();
    return fail(request.id, "RATE_LIMITED", "Client has too many running chat runs.");
  }
  if (context.runs.countRunning() >= (context.limits?.maxRunsTotal ?? 8)) {
    context.metrics?.rateLimitedRequest();
    return fail(request.id, "RATE_LIMITED", "Gateway has too many running chat runs.");
  }

  context.connections.subscribe(client.clientId, sessionId);
  const run = context.runs.createRun({ sessionId, requestId: request.id, clientId: client.clientId });
  context.metrics?.runStarted();
  const payload = { runId: run.runId, sessionId, requestId: request.id };
  beginIdempotency(request, context.idempotency, payload);
  queueMicrotask(() => {
    void executeChatRun(run.runId, input, context);
  });
  return ok(request.id, payload);
}

/**
 * 执行聊天运行任务并把 Gateway 内部事件桥接成 WS 事件。
 *
 * 这里负责 run.started、chat.delta、tool.*、chat.completed、run.finished/failed/cancelled
 * 的完整生命周期广播，同时把最终状态写回幂等记录和指标收集器。
 */
async function executeChatRun(
  runId: string,
  input: string,
  context: WsRouterContext
): Promise<void> {
  const run = context.runs.getRun(runId);
  if (!run) return;

  context.connections.broadcastToSession(run.sessionId, {
    type: "event",
    event: "run.started",
    runId,
    sessionId: run.sessionId,
    payload: { runId, inputPreview: input.slice(0, 200), startedAt: run.startedAt },
  });

  try {
    const session = findSession(context.runtime, run.sessionId);
    if (!session) throw new Error(`Session not found: ${run.sessionId}`);
    const gatewayRequest = createGatewayRequest(input, {
      sessionId: run.sessionId,
      activeSkills: session.activeSkills ?? [],
      permissionMode: session.permissionMode ?? "default",
      planState: session.planState,
    });
    const response = await context.runtime.gateway.handle(gatewayRequest, {
      signal: run.abortController.signal,
      onEvent: async (event) => {
        if (event.type === "chat.delta") {
          context.connections.broadcastToSession(run.sessionId, {
            type: "event",
            event: "chat.delta",
            runId,
            sessionId: run.sessionId,
            payload: { delta: event.delta },
          });
        } else if (event.type === "tool.started") {
          context.connections.broadcastToSession(run.sessionId, {
            type: "event",
            event: "tool.started",
            runId,
            sessionId: run.sessionId,
            payload: event,
          });
        } else {
          context.connections.broadcastToSession(run.sessionId, {
            type: "event",
            event: event.type,
            runId,
            sessionId: run.sessionId,
            payload: event.toolCall,
          });
        }
      },
    });

    context.connections.broadcastToSession(run.sessionId, {
      type: "event",
      event: "chat.completed",
      runId,
      sessionId: run.sessionId,
      payload: {
        responseId: response.id,
        text: response.text,
        memoryUsed: response.memoryUsed,
        toolCalls: response.toolCalls,
        debug: response.debug,
        error: response.error,
        createdAt: response.createdAt,
      },
    });
    const finished = context.runs.finishRun(runId);
    if (finished) {
      completeRunIdempotency(context, finished.requestId, { runId, sessionId: run.sessionId, requestId: finished.requestId });
      context.metrics?.runCompleted(runDurationMs(finished));
    }
    context.connections.broadcastToSession(run.sessionId, {
      type: "event",
      event: "run.finished",
      runId,
      sessionId: run.sessionId,
      payload: { runId, status: "completed" },
    });
  } catch (err) {
    const message = toErrorMessage(err);
    if (message === "RUN_CANCELLED" || run.abortController.signal.aborted) {
      if (context.runs.getRun(runId)?.status === "cancelled") {
        return;
      }
      const cancelled = context.runs.cancelRun(runId);
      if (cancelled) context.metrics?.runCancelled(runDurationMs(cancelled));
      context.connections.broadcastToSession(run.sessionId, {
        type: "event",
        event: "run.cancelled",
        runId,
        sessionId: run.sessionId,
        payload: { runId, status: "cancelled" },
      });
      return;
    }
    const failed = context.runs.failRun(runId, message);
    if (failed) {
      failRunIdempotency(context, failed.requestId, message);
      context.metrics?.runFailed(runDurationMs(failed));
    }
    context.connections.broadcastToSession(run.sessionId, {
      type: "event",
      event: "run.failed",
      runId,
      sessionId: run.sessionId,
      payload: { runId, error: message },
    });
  }
}

/** 取消正在运行的聊天任务，并广播 run.cancelled。 */
function handleChatCancel(request: WsRequest, context: WsRouterContext): WsResponse {
  const runId = String(asRecord(request.params)?.runId);
  const run = context.runs.getRun(runId);
  if (!run) return fail(request.id, "NOT_FOUND", `Run not found: ${runId}`);
  if (run.status !== "running") {
    return fail(request.id, "CONFLICT", `Run is already ${run.status}.`, run);
  }
  const cancelled = context.runs.cancelRun(runId);
  if (cancelled) {
    context.metrics?.runCancelled(runDurationMs(cancelled));
    context.connections.broadcastToSession(cancelled.sessionId, {
      type: "event",
      event: "run.cancelled",
      runId,
      sessionId: cancelled.sessionId,
      payload: { runId, status: "cancelled" },
    });
  }
  return ok(request.id, cancelled);
}

/** 调用已有记忆检索接口，返回搜索结果。 */
async function handleMemorySearch(request: WsRequest, context: WsRouterContext): Promise<WsResponse> {
  return ok(request.id, await context.runtime.memorySearch(String(asRecord(request.params)?.query)));
}

/**
 * 写入记忆并广播审计事件。
 *
 * 记忆写入属于有副作用操作，因此需要幂等保护；
 * 成功后同时写入审计日志，方便其他客户端立刻看到 audit.append。
 */
function handleMemoryWrite(request: WsRequest, context: WsRouterContext): WsResponse {
  const existing = checkIdempotency(request, context.idempotency);
  if (existing) return idempotencyResponse(request.id, existing);
  const params = asRecord(request.params)!;
  const sessionId = String(params.sessionId);
  if (!findSession(context.runtime, sessionId)) {
    return fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);
  }
  const payload = writeGatewayWsMemory({
    sessionId,
    content: String(params.content),
    scope: params.scope as "daily" | "long_term" | "auto" | undefined,
  });
  completeIdempotency(request, context.idempotency, payload);
  const auditPayload = { type: "memory.write", sessionId, filePath: payload.filePath, scope: payload.scope };
  void context.runtime.auditLogger.log({
    id: `ws-memory-${Date.now()}`,
    type: "ws.memory.write",
    message: "WS memory.write completed",
    createdAt: new Date().toISOString(),
    data: auditPayload,
  });
  context.connections.broadcastToSession(sessionId, {
    type: "event",
    event: "audit.append",
    sessionId,
    payload: auditPayload,
  });
  return ok(request.id, payload);
}

/**
 * 执行一次工具调用。
 *
 * 工具权限、项目边界和 plan 状态都从会话中读取，
 * 这样 WS 调用和 REPL/HTTP 调用共享同一套安全策略。
 */
async function handleToolCall(request: WsRequest, context: WsRouterContext): Promise<WsResponse> {
  const existing = checkIdempotency(request, context.idempotency);
  if (existing) return idempotencyResponse(request.id, existing);
  const params = asRecord(request.params)!;
  const sessionId = String(params.sessionId);
  const session = findSession(context.runtime, sessionId);
  const input = asRecord(params.input)!;
  if (!session) return fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);

  beginIdempotency(request, context.idempotency, { status: "running" });
  context.connections.broadcastToSession(sessionId, {
    type: "event",
    event: "tool.started",
    sessionId,
    payload: { toolName: params.toolName },
  });
  const toolCallRequest = createGatewayToolCallRequest({
    toolName: String(params.toolName),
    input,
    sessionId,
    requestId: request.id,
    permissionMode: session.permissionMode ?? "default",
    planState: session.planState,
    projectBoundary: extractProjectBoundary(session),
  });
  const record = await context.runtime.toolCallExecutor.execute(toolCallRequest);
  emitToolRecordEvent(sessionId, record, context);
  completeIdempotency(request, context.idempotency, record);
  return ok(request.id, record);
}

/** 列出指定会话中等待用户确认的审批项。 */
function handleApprovalList(request: WsRequest, context: WsRouterContext): WsResponse {
  const sessionId = String(asRecord(request.params)?.sessionId);
  if (!findSession(context.runtime, sessionId)) {
    return fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);
  }
  return ok(request.id, context.runtime.sessionManager.listSessionApprovals(sessionId));
}

/**
 * 确认一个待审批工具调用。
 *
 * 审批 token 被消费后会立即执行原始工具请求，
 * 并广播 approval.confirmed 以及对应的 tool.* 结果事件。
 */
async function handleApprovalConfirm(request: WsRequest, context: WsRouterContext): Promise<WsResponse> {
  const existing = checkIdempotency(request, context.idempotency);
  if (existing) return idempotencyResponse(request.id, existing);
  const params = asRecord(request.params)!;
  const sessionId = String(params.sessionId);
  const session = findSession(context.runtime, sessionId);
  if (!session) return fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);
  const result = context.runtime.sessionManager.consumeSessionApproval(sessionId, String(params.token));
  if (result.status !== "consumed" || !result.approval) {
    return fail(request.id, result.status === "missing" ? "NOT_FOUND" : "BAD_REQUEST", result.status);
  }
  const record = await context.runtime.toolCallExecutor.execute(createGatewayToolCallRequest({
    toolName: result.approval.toolName,
    input: result.approval.input,
    sessionId,
    requestId: request.id,
    approved: true,
    permissionMode: session.permissionMode ?? "default",
    planState: session.planState,
    projectBoundary: extractProjectBoundary(session),
  }));
  const payload = { approval: result.approval, toolCallRecord: record };
  completeIdempotency(request, context.idempotency, payload);
  context.connections.broadcastToSession(sessionId, {
    type: "event",
    event: "approval.confirmed",
    sessionId,
    payload,
  });
  emitToolRecordEvent(sessionId, record, context);
  return ok(request.id, payload);
}

/** 拒绝一个待审批工具调用，并广播 approval.rejected。 */
function handleApprovalReject(request: WsRequest, context: WsRouterContext): WsResponse {
  const existing = checkIdempotency(request, context.idempotency);
  if (existing) return idempotencyResponse(request.id, existing);
  const params = asRecord(request.params)!;
  const sessionId = String(params.sessionId);
  if (!findSession(context.runtime, sessionId)) {
    return fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);
  }
  const result = context.runtime.sessionManager.rejectSessionApproval(sessionId, String(params.token));
  if (result.status !== "rejected" || !result.approval) {
    return fail(request.id, result.status === "missing" ? "NOT_FOUND" : "BAD_REQUEST", result.status);
  }
  completeIdempotency(request, context.idempotency, result);
  context.connections.broadcastToSession(sessionId, {
    type: "event",
    event: "approval.rejected",
    sessionId,
    payload: result,
  });
  return ok(request.id, result);
}

/** 读取最近审计日志，支持按类型、会话、运行和工具名过滤。 */
function handleAuditTail(request: WsRequest, context: WsRouterContext): WsResponse {
  const params = asRecord(request.params) ?? {};
  return ok(request.id, readAuditTail(context.runtime.config.auditLogPath, {
    limit: typeof params.limit === "number" ? params.limit : undefined,
    type: typeof params.type === "string" ? params.type : undefined,
    sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
    runId: typeof params.runId === "string" ? params.runId : undefined,
    toolName: typeof params.toolName === "string" ? params.toolName : undefined,
  }));
}

/** 根据工具执行结果状态转换成对应的 WS 工具事件。 */
function emitToolRecordEvent(sessionId: string, record: GatewayToolCallRecord, context: WsRouterContext): void {
  context.connections.broadcastToSession(sessionId, {
    type: "event",
    event:
      record.status === "success"
        ? "tool.finished"
        : record.status === "denied"
          ? "tool.denied"
          : "tool.failed",
    sessionId,
    payload: record,
  });
}

/** 在运行时会话列表中查找指定会话。 */
function findSession(runtime: GatewayRuntime, sessionId: string) {
  return runtime.sessionManager.listSessions().find((session) => session.id === sessionId);
}

/** 把未知输入安全收窄成普通对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 统一把未知异常转换成可返回给客户端的错误文本。 */
function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 根据 run 的开始和结束时间计算耗时，时间无效时返回 undefined。 */
function runDurationMs(run: { startedAt: string; endedAt?: string }): number | undefined {
  if (!run.endedAt) return undefined;
  const started = Date.parse(run.startedAt);
  const ended = Date.parse(run.endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) ? ended - started : undefined;
}

/** 如果请求带幂等键，读取已有记录。 */
function checkIdempotency(request: WsRequest, idempotency: IdempotencyStore): IdempotencyRecord | undefined {
  return request.idempotencyKey ? idempotency.get(request.idempotencyKey) : undefined;
}

/** 为异步或写操作创建 running 状态幂等记录。 */
function beginIdempotency(request: WsRequest, idempotency: IdempotencyStore, payload: unknown): void {
  if (request.idempotencyKey) idempotency.begin(request.idempotencyKey, request.method, payload);
}

/** 完成幂等记录；如果之前没有 begin，则先补一条记录再完成。 */
function completeIdempotency(request: WsRequest, idempotency: IdempotencyStore, payload: unknown): void {
  if (!request.idempotencyKey) return;
  if (!idempotency.get(request.idempotencyKey)) {
    idempotency.begin(request.idempotencyKey, request.method, payload);
  }
  idempotency.complete(request.idempotencyKey, payload);
}

/** 将幂等记录标记为失败。 */
function failIdempotency(request: WsRequest, idempotency: IdempotencyStore, error: unknown): void {
  if (request.idempotencyKey) idempotency.fail(request.idempotencyKey, error);
}

/** 根据 requestId 找到关联幂等记录，并写入运行成功结果。 */
function completeRunIdempotency(context: WsRouterContext, requestId: string, payload: unknown): void {
  for (const record of findIdempotencyRecords(context.idempotency, requestId)) {
    context.idempotency.complete(record.key, payload);
  }
}

/** 根据 requestId 找到关联幂等记录，并写入运行失败结果。 */
function failRunIdempotency(context: WsRouterContext, requestId: string, error: unknown): void {
  for (const record of findIdempotencyRecords(context.idempotency, requestId)) {
    context.idempotency.fail(record.key, error);
  }
}

/** 通过幂等记录 payload 中的 requestId 反查异步运行所属请求。 */
function findIdempotencyRecords(idempotency: IdempotencyStore, requestId: string): IdempotencyRecord[] {
  return idempotency.list().filter((record) => asRecord(record.payload)?.requestId === requestId);
}

/** 把幂等记录转换成当前请求的响应。 */
function idempotencyResponse(id: string, record: IdempotencyRecord): WsResponse {
  if (record.status === "failed") {
    return fail(id, "CONFLICT", "Idempotent request previously failed.", record.error);
  }
  return ok(id, { status: record.status, payload: record.payload });
}
