/**
 * ?????CS336 ???
 * ???packages/gateway/ws/router.ts
 * ???WebSocket ????
 * ????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readTranscript } from "../../session/src/transcript";
import { discoverSkills, getSkillByName } from "../../core/src/skills";
import { recordTranscript } from "../transcriptRecorder";
import { readAuditTail } from "./auditTail";
import { getSessionUsage, getSessionRecords } from "../../storage/src/usageStore";
import { createGatewayRequest } from "../requestHandler";
import { extractProjectBoundary, type GatewaySession } from "../sessionTypes";
import { createGatewayToolCallRequest } from "../toolCallFactory";
import type { GatewayToolCallRecord } from "../toolCallTypes";
import type { GatewayRuntime } from "../runtime";
import { upsertProjectMcpServerConfig } from "../mcpConfig";
import { normalizeGatewayModelName } from "../config";
import { MODEL_PROVIDER_OPTIONS } from "../modelProviderFactory";
import type { GatewayMcpServerConfig } from "../mcpTypes";
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
import {
  extractStructuredJsonRanges,
  extractMeaningfulContent,
  tryParseStructuredPayload,
} from "../textSanitizer";

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
 * Args:
 *   client: 当前连接对象，包含 clientId、发送能力和连接状态。
 *   request: 客户端发来的协议消息，必须符合 `WsRequest` 结构。
 *   context: 共享路由上下文，包含 runtime、连接管理器、run 管理器和事件缓冲。
 *
 * Returns:
 *   Promise<WsResponse | void>：同步方法直接返回响应；异步 run 类方法返回 void，并通过事件推送后续状态。
 *
 * 实现步骤：
 *   1. 更新连接活跃时间并做参数 schema 校验。
 *   2. 按 `request.method` 进入对应处理器。
 *   3. 对 chat/tool 等写操作应用幂等、并发和背压策略。
 *   4. 将运行过程转换成 `run.*`、`chat.*`、`tool.*` 等实时事件。
 */
export async function handleWsRequest(
  client: WsClientConnection,
  request: WsRequest,
  context: WsRouterContext
): Promise<WsResponse | void> {
  // Learning note: this switch is the WebSocket API surface. Add a new WS method
  // by validating params in schemas.ts, routing here, then testing router behavior.
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
    case "runtime.updateConfig":
      return handleRuntimeUpdateConfig(request, context);
    case "session.list":
      return ok(request.id, context.runtime.sessionManager.listSessions());
    case "session.get":
      return handleSessionGet(request, context);
    case "session.create":
      return handleSessionCreate(request, context);
    case "session.rename":
      return handleSessionRename(client, request, context);
    case "session.delete":
      return handleSessionDelete(request, context);
    case "session.purge":
      return handleSessionPurge(request, context);
    case "session.usage":
      return handleSessionUsage(request);
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
    case "mcp.status":
      return ok(request.id, {
        statuses: context.runtime.mcpManager.listStatuses(),
        total: context.runtime.mcpManager.listStatuses().length,
      });
    case "mcp.tools":
      return ok(request.id, {
        tools: context.runtime.mcpManager.listTools(),
        total: context.runtime.mcpManager.listTools().length,
      });
    case "mcp.config.add":
      return handleMcpConfigAdd(request, context);
    case "skills.list":
      return handleSkillsList(request);
    case "skills.current":
      return handleSkillsCurrent(request, context);
    case "skills.use":
      return handleSkillsUse(request, context);
    case "skills.clear":
      return handleSkillsClear(request, context);
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
    modelProvider: context.runtime.modelProvider.name,
    supportsStreaming: Boolean(context.runtime.modelProvider.supportsStreaming ?? false),
    availableModels: MODEL_PROVIDER_OPTIONS,
    debug: context.runtime.config.debug,
    sandboxMode: context.runtime.config.sandboxMode,
    toolCount: context.runtime.toolRegistry.list().length,
    sessionCount: context.runtime.sessionManager.listSessions().length,
    currentSessionId: context.runtime.sessionManager.getCurrentSessionId(),
    autoToolLoopEnabled: context.runtime.config.autoToolLoopEnabled,
    autoReviewGraphEnabled: context.runtime.config.autoReviewGraphEnabled,
    sandboxAllowedRoots: context.runtime.config.sandboxAllowedRoots,
    metrics: context.runtime.metricsCollector.snapshot("closed"),
    wsMetrics: context.metrics?.snapshot(),
  };
}

const UPDATABLE_CONFIG_KEYS = new Set([
  "autoToolLoopEnabled",
  "autoReviewGraphEnabled",
  "model",
]);

function handleRuntimeUpdateConfig(request: WsRequest, context: WsRouterContext): WsResponse {
  const params = asRecord(request.params);
  if (!params) {
    return fail(request.id, "BAD_REQUEST", "Missing config params.");
  }
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "model" && typeof value === "string") {
      const model = normalizeGatewayModelName(value);
      if (!model) {
        continue;
      }
      context.runtime.setModelProvider(model);
      updates[key] = model;
    } else if (UPDATABLE_CONFIG_KEYS.has(key) && typeof value === "boolean") {
      (context.runtime.config as unknown as Record<string, unknown>)[key] = value;
      if (key === "autoReviewGraphEnabled") {
        context.runtime.gateway.autoReviewGraphEnabled = value;
      }
      updates[key] = value;
    }
  }
  if (Object.keys(updates).length === 0) {
    return fail(request.id, "BAD_REQUEST", "No valid config keys provided.");
  }
  return ok(request.id, { updated: updates, ...getRuntimeStatus(context) });
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

/** 重命名指定会话；未传 sessionId 时回落到当前会话。 */
function handleSessionRename(client: WsClientConnection, request: WsRequest, context: WsRouterContext): WsResponse {
  const params = asRecord(request.params);
  const currentSessionId = context.runtime.sessionManager.getCurrentSessionId();
  const targetSessionId = typeof params?.sessionId === "string" ? params.sessionId : currentSessionId;
  if (!findSession(context.runtime, targetSessionId)) {
    return fail(request.id, "NOT_FOUND", `Session not found: ${targetSessionId}`);
  }
  const session = context.runtime.sessionManager.renameSession(targetSessionId, String(params?.name));
  context.connections.subscribe(client.clientId, session.id);
  context.connections.broadcastToSession(session.id, {
    type: "event",
    event: "session.updated",
    sessionId: session.id,
    payload: session,
  });
  return ok(request.id, session);
}

function handleSessionDelete(request: WsRequest, context: WsRouterContext): WsResponse {
  const params = asRecord(request.params);
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
  if (!sessionId) {
    return fail(request.id, "BAD_REQUEST", "sessionId is required.");
  }
  if (!findSession(context.runtime, sessionId)) {
    return fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);
  }
  const deleted = context.runtime.sessionManager.deleteSession(sessionId);
  if (!deleted) {
    return fail(request.id, "INTERNAL_ERROR", "Failed to delete session.");
  }
  context.connections.broadcastToSession(sessionId, {
    type: "event",
    event: "session.updated",
    sessionId,
    payload: { deleted: true },
  });
  return ok(request.id, { deleted: true, sessionId });
}

function handleSessionPurge(request: WsRequest, context: WsRouterContext): WsResponse {
  const params = asRecord(request.params);
  const keepRecent = typeof params?.keepRecent === "number" ? params.keepRecent : 10;
  const olderThanDays = typeof params?.olderThanDays === "number" ? params.olderThanDays : 30;
  const result = context.runtime.sessionManager.purgeSessions({ keepRecent, olderThanDays });
  return ok(request.id, result);
}

function handleSessionUsage(request: WsRequest): WsResponse {
  const params = asRecord(request.params);
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
  if (!sessionId) {
    return fail(request.id, "BAD_REQUEST", "sessionId is required.");
  }
  const summary = getSessionUsage(sessionId);
  const records = getSessionRecords(sessionId, 20);
  return ok(request.id, { summary, records });
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
  return ok(request.id, {
    sessionId,
    messages: readTranscript(sessionId),
  });
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
  let session = findSession(context.runtime, sessionId);
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
  session = maybeAutoBindProjectFromInput(session, input, context);
  recordSessionMessage(context, sessionId, "user", input);
  const run = context.runs.createRun({ sessionId, requestId: request.id, clientId: client.clientId });
  context.metrics?.runStarted();
  const payload = { runId: run.runId, sessionId, requestId: request.id };
  beginIdempotency(request, context.idempotency, payload);
  queueMicrotask(() => {
    void executeChatRun(run.runId, input, context);
  });
  return ok(request.id, payload);
}

function maybeAutoBindProjectFromInput(
  session: GatewaySession,
  input: string,
  context: WsRouterContext
): GatewaySession {
  if (session.projectBound && session.projectDir) {
    return session;
  }

  const projectDir = findExistingDirectoryMention(input);
  if (!projectDir) {
    return session;
  }

  try {
    const payload = context.runtime.sessionManager.bindProjectDir(
      session.id,
      projectDir,
      context.runtime.config.sandboxAllowedRoots,
      "user-path"
    );
    context.connections.broadcastToSession(session.id, {
      type: "event",
      event: "session.updated",
      sessionId: session.id,
      payload: payload.session,
    });
    return payload.session;
  } catch {
    return session;
  }
}

function findExistingDirectoryMention(input: string): string | undefined {
  const candidates: string[] = [];
  const delimitedPathPattern = /[`'"]([A-Za-z]:[\\/][^`'"\r\n]+)[`'"]/g;
  for (const match of input.matchAll(delimitedPathPattern)) {
    candidates.push(match[1]);
  }

  const barePathPattern = /[A-Za-z]:[\\/][^\s`'"\r\n<>|?*]+/g;
  for (const match of input.matchAll(barePathPattern)) {
    candidates.push(match[0]);
  }

  for (const candidate of candidates) {
    const existing = resolveExistingDirectoryCandidate(candidate);
    if (existing) {
      return existing;
    }
  }

  return undefined;
}

function resolveExistingDirectoryCandidate(candidate: string): string | undefined {
  let current = stripPathPunctuation(candidate.trim()).replace(/\//g, "\\");
  if (!current) {
    return undefined;
  }

  current = path.resolve(current);
  for (let i = 0; i < 32; i += 1) {
    if (isDriveRoot(current)) {
      return undefined;
    }
    try {
      if (fs.existsSync(current)) {
        const stat = fs.statSync(current);
        return stat.isDirectory() ? current : path.dirname(current);
      }
    } catch {
      return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }

  return undefined;
}

function stripPathPunctuation(value: string): string {
  return value.replace(/[\s.,，。;；:：!！?？)）\]】}"'`]+$/g, "");
}

function isDriveRoot(value: string): boolean {
  const parsed = path.parse(value);
  return path.resolve(value).toLowerCase() === parsed.root.toLowerCase();
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
    payload: {
      runId,
      inputPreview: input.slice(0, 200),
      startedAt: run.startedAt,
      model: context.runtime.config.model,
      modelProvider: context.runtime.modelProvider.name,
      supportsStreaming: Boolean(context.runtime.modelProvider.supportsStreaming ?? false),
      autoToolLoopEnabled: context.runtime.config.autoToolLoopEnabled,
      autoReviewGraphEnabled: context.runtime.config.autoReviewGraphEnabled,
    },
  });

  context.connections.broadcastToSession(run.sessionId, {
    type: "event",
    event: "run.progress",
    runId,
    sessionId: run.sessionId,
    payload: {
      title: "准备上下文",
      stage: "context",
      state: "running",
      detail: context.runtime.config.autoReviewGraphEnabled ? "多 Agent 编排已开启" : "单 Agent 模式",
    },
  });

  try {
    const session = findSession(context.runtime, run.sessionId);
    if (!session) throw new Error(`Session not found: ${run.sessionId}`);
    const gatewayRequest = createGatewayRequest(input, {
      sessionId: run.sessionId,
      activeSkills: session.activeSkills ?? [],
      permissionMode: session.permissionMode ?? "default",
      planState: session.planState,
      projectBoundary: extractProjectBoundary(session),
    });

    context.connections.broadcastToSession(run.sessionId, {
      type: "event",
      event: "run.progress",
      runId,
      sessionId: run.sessionId,
      payload: {
        title: "调用模型",
        stage: "model",
        state: "running",
        detail: `${context.runtime.modelProvider.name} / ${context.runtime.config.model}`,
      },
    });

    // Buffer delta text to suppress raw JSON from being sent to the client.
    // When the model streams a tool_call or final JSON, we accumulate it here
    // and only forward non-JSON text deltas.
    let deltaBuffer = "";
    let jsonDetected = false;

    const response = await context.runtime.gateway.handle(gatewayRequest, {
      signal: run.abortController.signal,
      onEvent: async (event) => {
        if (event.type === "chat.delta") {
          deltaBuffer += event.delta;

          if (jsonDetected) {
            // Already detected JSON in the buffer — suppress all subsequent deltas
            return;
          }

          // Check if the buffer contains a JSON structure
          const jsonStart = deltaBuffer.indexOf('{"');
          if (jsonStart >= 0 && (deltaBuffer.includes('"type"') || deltaBuffer.includes('"tool"'))) {
            jsonDetected = true;
            // If there's plain text before the JSON, forward just that part
            const textPrefix = deltaBuffer.slice(0, jsonStart).trim();
            if (textPrefix) {
              context.connections.broadcastToSession(run.sessionId, {
                type: "event",
                event: "chat.delta",
                runId,
                sessionId: run.sessionId,
                payload: { delta: textPrefix, text: textPrefix },
              });
            }
            return;
          }

          // No JSON detected yet — forward the delta
          context.connections.broadcastToSession(run.sessionId, {
            type: "event",
            event: "chat.delta",
            runId,
            sessionId: run.sessionId,
            payload: { delta: event.delta, text: event.delta },
          });
        } else if (event.type === "tool.started") {
          // Tool call JSON was complete — clear the buffer
          deltaBuffer = "";
          jsonDetected = false;
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

    const responseText = normalizeAssistantResponseText(response.text);
    try { const fs = require("node:fs"); fs.mkdirSync("logs", { recursive: true }); fs.appendFileSync("logs/model-debug.log", `[COMPLETED] response.text.len=${response.text.length} responseText.len=${responseText.length}\n[COMPLETED] responseText=${JSON.stringify(responseText).slice(0, 500)}\n`); } catch {}
    recordSessionMessage(context, run.sessionId, "assistant", responseText);
    context.connections.broadcastToSession(run.sessionId, {
      type: "event",
      event: "chat.completed",
      runId,
      sessionId: run.sessionId,
      payload: {
        responseId: response.id,
        text: responseText,
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

async function handleMcpConfigAdd(
  request: WsRequest,
  context: WsRouterContext
): Promise<WsResponse> {
  const existing = checkIdempotency(request, context.idempotency);
  if (existing) return idempotencyResponse(request.id, existing);
  const server = normalizeMcpServerConfig(asRecord(asRecord(request.params)?.server));
  if (!server) {
    return fail(request.id, "BAD_REQUEST", "Invalid MCP server config.");
  }

  const writeResult = upsertProjectMcpServerConfig(server);
  const status = await context.runtime.mcpManager.addOrUpdateServer(
    server,
    context.runtime.toolRegistry
  );
  const payload = {
    server,
    status,
    statuses: context.runtime.mcpManager.listStatuses(),
    configPath: writeResult.configPath,
  };
  completeIdempotency(request, context.idempotency, payload);
  return ok(request.id, payload);
}

function handleSkillsList(request: WsRequest): WsResponse {
  const skills = discoverSkills().skills.map((skill) => ({
    name: skill.name,
    title: skill.title,
    description: skill.description,
    platform: skill.platform,
    source: skill.source,
    relativePath: skill.relativePath,
    userInvocable: skill.userInvocable,
    aliases: skill.aliases,
    priority: skill.priority,
  }));
  return ok(request.id, { skills, total: skills.length });
}

function handleSkillsCurrent(request: WsRequest, context: WsRouterContext): WsResponse {
  const sessionId = String(asRecord(request.params)?.sessionId);
  const session = findSession(context.runtime, sessionId);
  if (!session) return fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);
  return ok(request.id, {
    sessionId,
    activeSkills: session.activeSkills ?? [],
  });
}

function handleSkillsUse(request: WsRequest, context: WsRouterContext): WsResponse {
  const params = asRecord(request.params)!;
  const sessionId = String(params.sessionId);
  const session = findSession(context.runtime, sessionId);
  if (!session) return fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);

  const skillName = String(params.skillName);
  const skill = getSkillByName(skillName, discoverSkills().skills);
  if (!skill) return fail(request.id, "NOT_FOUND", `Skill not found: ${skillName}`);

  const activeSkills = [...new Set([...(session.activeSkills ?? []), skill.name])];
  const updated = context.runtime.sessionManager.setSessionSkills(sessionId, activeSkills);
  context.connections.broadcastToSession(sessionId, {
    type: "event",
    event: "session.updated",
    sessionId,
    payload: updated,
  });
  return ok(request.id, {
    sessionId,
    activeSkills: updated.activeSkills ?? [],
    activated: skill.name,
  });
}

function handleSkillsClear(request: WsRequest, context: WsRouterContext): WsResponse {
  const sessionId = String(asRecord(request.params)?.sessionId);
  const session = findSession(context.runtime, sessionId);
  if (!session) return fail(request.id, "NOT_FOUND", `Session not found: ${sessionId}`);
  const updated = context.runtime.sessionManager.setSessionSkills(sessionId, []);
  context.connections.broadcastToSession(sessionId, {
    type: "event",
    event: "session.updated",
    sessionId,
    payload: updated,
  });
  return ok(request.id, {
    sessionId,
    activeSkills: updated.activeSkills ?? [],
  });
}

function normalizeMcpServerConfig(
  input: Record<string, unknown> | undefined
): GatewayMcpServerConfig | undefined {
  if (!input || typeof input.id !== "string" || typeof input.command !== "string") {
    return undefined;
  }

  const id = input.id.trim();
  const command = input.command.trim();
  if (!id || !command) {
    return undefined;
  }

  const isolation = asRecord(input.isolation);
  return {
    id,
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : id,
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    transport: "stdio",
    command,
    args: Array.isArray(input.args)
      ? input.args.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : undefined,
    cwd: typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined,
    env: isStringRecord(input.env) ? input.env : undefined,
    toolNamePrefix:
      typeof input.toolNamePrefix === "string" && input.toolNamePrefix.trim()
        ? input.toolNamePrefix.trim()
        : `mcp.${id}`,
    isolation: isolation
      ? {
          enabled: typeof isolation.enabled === "boolean" ? isolation.enabled : false,
          mode: isolation.mode === "inherit" ? "inherit" : "restricted",
          runtimeRoot:
            typeof isolation.runtimeRoot === "string" && isolation.runtimeRoot.trim()
              ? isolation.runtimeRoot.trim()
              : undefined,
          preserveEnvKeys: Array.isArray(isolation.preserveEnvKeys)
            ? isolation.preserveEnvKeys.filter((item): item is string => typeof item === "string" && item.trim() !== "")
            : undefined,
        }
      : { enabled: false, mode: "inherit" },
  };
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
function recordSessionMessage(
  context: WsRouterContext,
  sessionId: string,
  role: "user" | "assistant",
  content: string
): void {
  try {
    recordTranscript(sessionId, role, content);
    context.runtime.sessionManager.incrementSessionMessageCount(sessionId);
  } catch {
    // Transcript persistence must not break a live websocket response.
  }
}

function normalizeAssistantResponseText(raw: string): string {
  const cleaned = raw.trim().replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!cleaned) {
    try { const fs = require("node:fs"); fs.mkdirSync("logs", { recursive: true }); fs.appendFileSync("logs/model-debug.log", `[NORMALIZE] empty after think strip, raw.len=${raw.length}\n`); } catch {}
    return raw.trim();
  }

  if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
    const parsed = tryParseStructuredPayload(cleaned);
    if (parsed && parsed.type !== "tool_call") {
      const content = extractMeaningfulContent(parsed);
      if (content) {
        try { const fs = require("node:fs"); fs.appendFileSync("logs/model-debug.log", `[NORMALIZE] JSON path → content.len=${content.length}\n`); } catch {}
        return content;
      }
    }
  }

  const structured = extractStructuredJsonRanges(cleaned)
    .map((entry) => ({
      ...entry,
      parsed: tryParseStructuredPayload(entry.json),
    }));
  const finalPayload = [...structured]
    .reverse()
    .find((entry) => entry.parsed?.type === "final" && typeof entry.parsed.content === "string" && entry.parsed.content.trim() !== "");
  if (finalPayload?.parsed && typeof finalPayload.parsed.content === "string") {
    try { const fs = require("node:fs"); fs.appendFileSync("logs/model-debug.log", `[NORMALIZE] finalPayload path → content.len=${finalPayload.parsed.content.trim().length}\n`); } catch {}
    return finalPayload.parsed.content.trim();
  }

  let text = cleaned;
  for (const entry of [...structured].reverse()) {
    if (entry.parsed) {
      const content = extractMeaningfulContent(entry.parsed);
      if (content && !entry.parsed.type) {
        try { const fs = require("node:fs"); fs.appendFileSync("logs/model-debug.log", `[NORMALIZE] meaningfulContent path → content.len=${content.length}\n`); } catch {}
        return content;
      }
    }
    if (entry.parsed?.type === "tool_call" || entry.parsed?.type === "final") {
      text = text.slice(0, entry.start) + text.slice(entry.end);
    }
  }

  text = text
    .replace(/\[Tool Result\][\s\S]*?\[\/Tool Result\]/g, "")
    .replace(/^\[[^\]]*JSON[^\]]*\]\s*$/gim, "")
    .replace(/^\[TOOL_CALL\]\s*/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  try { const fs = require("node:fs"); fs.appendFileSync("logs/model-debug.log", `[NORMALIZE] fallback path → text.len=${text.length}\n`); } catch {}
  return text;
}

function findSession(runtime: GatewayRuntime, sessionId: string) {
  return runtime.sessionManager.listSessions().find((session) => session.id === sessionId);
}

/** 把未知输入安全收窄成普通对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (item) => typeof item === "string"
    )
  );
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
