
export const GATEWAY_WS_PROTOCOL_VERSION = "1.0";

/**
 * 客户端可以通过 WS 请求调用的方法列表。
 *
 * 命名沿用 `领域.动作` 的形式，让会话、聊天、记忆、工具和审计能力
 * 都能在一条 WebSocket 连接里复用同一种请求/响应封装。
 */
export type GatewayWsMethod =
  | "connect"
  | "ping"
  | "runtime.status"
  | "session.list"
  | "session.get"
  | "session.create"
  | "session.rename"
  | "session.bindProject"
  | "session.getTranscript"
  | "chat.send"
  | "chat.cancel"
  | "memory.search"
  | "memory.write"
  | "mcp.status"
  | "mcp.tools"
  | "mcp.config.add"
  | "skills.list"
  | "skills.current"
  | "skills.use"
  | "skills.clear"
  | "tool.list"
  | "tool.call"
  | "approval.list"
  | "approval.confirm"
  | "approval.reject"
  | "audit.tail";

/**
 * 服务端主动推送给客户端的事件类型。
 *
 * 事件与请求响应解耦：请求只确认命令是否被接收，
 * 长耗时任务的进度、工具调用和最终结果通过事件持续广播。
 */
export type GatewayWsEvent =
  | "connected"
  | "heartbeat"
  | "run.started"
  | "run.progress"
  | "run.finished"
  | "run.failed"
  | "run.cancelled"
  | "chat.completed"
  | "chat.delta"
  | "tool.started"
  | "tool.finished"
  | "tool.failed"
  | "tool.denied"
  | "approval.required"
  | "approval.confirmed"
  | "approval.rejected"
  | "session.updated"
  | "audit.append"
  | "server.shutdown"
  | "state.resync_required";

/**
 * 协议层可返回的标准错误码。
 *
 * 这些错误码刻意接近 HTTP/业务状态语义，客户端无需解析错误文本
 * 就能决定是重试、重新鉴权、提示用户还是触发本地状态重同步。
 */
export type GatewayWsErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "RUN_CANCELLED"
  | "POLICY_DENIED"
  | "TOOL_FAILED"
  | "MODEL_FAILED"
  | "NOT_IMPLEMENTED"
  | "INTERNAL_ERROR";

/**
 * 客户端发往 Gateway 的统一请求包。
 *
 * `id` 用来匹配响应，`idempotencyKey` 用来保护可重复提交的写操作，
 * `clientSeq` 预留给客户端侧顺序校验或诊断。
 */
export interface WsRequest {
  type: "req";
  id: string;
  method: GatewayWsMethod;
  params?: unknown;
  idempotencyKey?: string;
  clientSeq?: number;
}

/**
 * Gateway 对单个请求返回的同步响应包。
 *
 * 对于 `chat.send` 这类异步任务，响应只代表“任务已创建”，
 * 后续进度和结果会通过 `WsEvent` 推送。
 */
export interface WsResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: GatewayWsErrorCode;
    message: string;
    details?: unknown;
  };
}

/**
 * 服务端推送事件的统一包。
 *
 * `seq` 是可回放事件序号，客户端断线重连时可以用它向服务端请求补发；
 * `runId` 和 `sessionId` 用来把事件归属到具体会话和运行任务。
 */
export interface WsEvent {
  type: "event";
  seq: number;
  event: GatewayWsEvent;
  runId?: string;
  sessionId?: string;
  payload?: unknown;
  createdAt: string;
}

export type WsClientMessage = WsRequest;
export type WsServerMessage = WsResponse | WsEvent;

const GATEWAY_WS_METHODS = new Set<string>([
  "connect",
  "ping",
  "runtime.status",
  "session.list",
  "session.get",
  "session.create",
  "session.rename",
  "session.bindProject",
  "session.getTranscript",
  "chat.send",
  "chat.cancel",
  "memory.search",
  "memory.write",
  "mcp.status",
  "mcp.tools",
  "mcp.config.add",
  "skills.list",
  "skills.current",
  "skills.use",
  "skills.clear",
  "tool.list",
  "tool.call",
  "approval.list",
  "approval.confirm",
  "approval.reject",
  "audit.tail",
]);

/** 构造成功响应，避免各路由手写重复的响应包结构。 */
export function ok(id: string, payload?: unknown): WsResponse {
  return payload === undefined
    ? { type: "res", id, ok: true }
    : { type: "res", id, ok: true, payload };
}

/** 构造失败响应，并在有 `details` 时保留结构化诊断信息。 */
export function fail(
  id: string,
  code: GatewayWsErrorCode,
  message: string,
  details?: unknown
): WsResponse {
  return {
    type: "res",
    id,
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

/**
 * 对外部输入做最小协议形状校验。
 *
 * 这里不校验每个方法的业务参数，只确认它确实是一个 WS 请求；
 * 具体参数约束交给 `schemas.ts`，让协议解析和业务校验保持分层。
 */
export function isWsRequest(value: unknown): value is WsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "req") {
    return false;
  }
  if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
    return false;
  }
  if (
    typeof candidate.method !== "string" ||
    candidate.method.trim() === "" ||
    !GATEWAY_WS_METHODS.has(candidate.method)
  ) {
    return false;
  }
  if (
    candidate.idempotencyKey !== undefined &&
    typeof candidate.idempotencyKey !== "string"
  ) {
    return false;
  }
  if (
    candidate.clientSeq !== undefined &&
    (typeof candidate.clientSeq !== "number" || !Number.isFinite(candidate.clientSeq))
  ) {
    return false;
  }

  return true;
}
