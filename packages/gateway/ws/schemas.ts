
import type { GatewayWsErrorCode, WsRequest } from "./protocol";
import { normalizeGatewayModelName } from "../config";

/** 单次聊天输入的最大字符数，防止用户消息直接撑爆模型上下文或内存。 */
export const WS_MAX_CHAT_INPUT_CHARS = 64 * 1024;
/** 工具输入序列化后的最大字节数，避免通过 WS 绕过工具层大小限制。 */
export const WS_MAX_TOOL_INPUT_BYTES = 512 * 1024;
/** 记忆写入内容最大字符数，防止把大文件误写进长期记忆。 */
export const WS_MAX_MEMORY_CONTENT_CHARS = 16 * 1024;

/** 参数校验结果，失败时带协议错误码和可选细节。 */
export type SchemaResult =
  | { ok: true }
  | { ok: false; code: GatewayWsErrorCode; message: string; details?: unknown };

/**
 * 按请求方法校验 `params`。
 *
 * `protocol.ts` 只负责识别消息是不是合法请求；
 * 这里再按方法约束必填字段、字符串长度和对象形状。
 */
export function validateWsRequestParams(request: WsRequest): SchemaResult {
  switch (request.method) {
    case "connect":
      return validateConnect(request.params);
    case "ping":
    case "runtime.status":
    case "session.list":
    case "tool.list":
      return { ok: true };
    case "runtime.updateConfig":
      return validateRuntimeUpdateConfig(request.params);
    case "session.get":
      return validateOptionalSessionId(request.params);
    case "session.create":
      return validateSessionCreate(request.params);
    case "session.rename":
      return validateSessionRename(request.params);
    case "session.delete":
      return validateStringFields(request.params, ["sessionId"]);
    case "session.purge":
      return validateSessionPurge(request.params);
    case "session.usage":
      return validateStringFields(request.params, ["sessionId"]);
    case "session.bindProject":
      return validateStringFields(request.params, ["sessionId", "projectDir"]);
    case "session.getTranscript":
      return validateStringFields(request.params, ["sessionId"]);
    case "chat.send":
      return validateChatSend(request.params);
    case "chat.cancel":
      return validateStringFields(request.params, ["runId"]);
    case "memory.search":
      return validateMemorySearch(request.params);
    case "memory.write":
      return validateMemoryWrite(request.params);
    case "mcp.status":
    case "mcp.tools":
    case "skills.list":
      return { ok: true };
    case "mcp.config.add":
      return validateMcpConfigAdd(request.params);
    case "skills.current":
    case "skills.clear":
      return validateStringFields(request.params, ["sessionId"]);
    case "skills.use":
      return validateStringFields(request.params, ["sessionId", "skillName"]);
    case "tool.call":
      return validateToolCall(request.params);
    case "approval.list":
      return validateStringFields(request.params, ["sessionId"]);
    case "approval.confirm":
    case "approval.reject":
      return validateStringFields(request.params, ["sessionId", "token"]);
    case "audit.tail":
      return validateAuditTail(request.params);
  }

  return {
    ok: false,
    code: "NOT_IMPLEMENTED",
    message: `Unsupported WebSocket method: ${request.method}`,
  };
}

/** 校验连接握手参数，包括协议版本和断线恢复游标。 */
function validateConnect(params: unknown): SchemaResult {
  const record = asRecord(params);
  if (!record) {
    return { ok: true };
  }
  if (
    record.protocolVersion !== undefined &&
    typeof record.protocolVersion !== "string"
  ) {
    return bad("connect.params.protocolVersion must be a string.");
  }
  const resume = asRecord(record.resume);
  if (record.resume !== undefined && !resume) {
    return bad("connect.params.resume must be an object.");
  }
  if (resume) {
    if (typeof resume.sessionId !== "string" || resume.sessionId.trim() === "") {
      return bad("connect.params.resume.sessionId is required.");
    }
    if (typeof resume.lastSeq !== "number" || !Number.isFinite(resume.lastSeq)) {
      return bad("connect.params.resume.lastSeq must be a number.");
    }
  }
  return { ok: true };
}

/** 校验可选 sessionId，缺省时由路由层回落到当前会话。 */
function validateOptionalSessionId(params: unknown): SchemaResult {
  const record = asRecord(params);
  if (!record) {
    return { ok: true };
  }
  if (record.sessionId !== undefined && !isNonEmptyString(record.sessionId)) {
    return bad("params.sessionId must be a non-empty string.");
  }
  return { ok: true };
}

/** 校验会话创建参数，目前只允许短名称。 */
function validateSessionCreate(params: unknown): SchemaResult {
  const record = asRecord(params);
  if (!record) {
    return { ok: true };
  }
  if (record.name !== undefined && !isBoundedString(record.name, 120)) {
    return bad("session.create params.name must be a string up to 120 chars.");
  }
  return { ok: true };
}

/** 校验会话重命名参数，同时允许指定 sessionId。 */
function validateSessionRename(params: unknown): SchemaResult {
  const result = validateStringFields(params, ["name"]);
  if (!result.ok) {
    return result;
  }
  if (!isBoundedString(asRecord(params)?.name, 120)) {
    return bad("session.rename params.name must be a string up to 120 chars.");
  }
  return validateOptionalSessionId(params);
}

/** 校验聊天请求，重点限制输入长度。 */
function validateChatSend(params: unknown): SchemaResult {
  const result = validateStringFields(params, ["sessionId", "input"]);
  if (!result.ok) {
    return result;
  }
  const input = asRecord(params)?.input;
  if (!isBoundedString(input, WS_MAX_CHAT_INPUT_CHARS)) {
    return bad(`chat.send input exceeds ${WS_MAX_CHAT_INPUT_CHARS} chars.`);
  }
  return { ok: true };
}

/** 校验记忆搜索请求，避免超长查询进入检索层。 */
function validateMemorySearch(params: unknown): SchemaResult {
  const result = validateStringFields(params, ["query"]);
  if (!result.ok) {
    return result;
  }
  if (!isBoundedString(asRecord(params)?.query, 2048)) {
    return bad("memory.search query exceeds 2048 chars.");
  }
  return { ok: true };
}

/** 校验记忆写入请求，包括内容长度和范围枚举。 */
function validateMemoryWrite(params: unknown): SchemaResult {
  const result = validateStringFields(params, ["sessionId", "content"]);
  if (!result.ok) {
    return result;
  }
  const record = asRecord(params);
  if (!isBoundedString(record?.content, WS_MAX_MEMORY_CONTENT_CHARS)) {
    return bad(`memory.write content exceeds ${WS_MAX_MEMORY_CONTENT_CHARS} chars.`);
  }
  if (
    record?.scope !== undefined &&
    record.scope !== "daily" &&
    record.scope !== "long_term" &&
    record.scope !== "auto"
  ) {
    return bad("memory.write scope must be daily, long_term, or auto.");
  }
  return { ok: true };
}

/** Validate the MCP server editor payload accepted by the web UI. */
function validateMcpConfigAdd(params: unknown): SchemaResult {
  const record = asRecord(params);
  const server = asRecord(record?.server);
  if (!server) {
    return bad("mcp.config.add params.server must be an object.");
  }
  for (const field of ["id", "command"]) {
    if (!isNonEmptyString(server[field])) {
      return bad(`mcp.config.add server.${field} is required.`);
    }
  }
  for (const field of ["name", "cwd", "toolNamePrefix", "transport"]) {
    if (server[field] !== undefined && typeof server[field] !== "string") {
      return bad(`mcp.config.add server.${field} must be a string.`);
    }
  }
  if (server.enabled !== undefined && typeof server.enabled !== "boolean") {
    return bad("mcp.config.add server.enabled must be a boolean.");
  }
  if (server.transport !== undefined && server.transport !== "stdio") {
    return bad("mcp.config.add only supports stdio transport.");
  }
  if (server.args !== undefined && !isStringArray(server.args)) {
    return bad("mcp.config.add server.args must be an array of strings.");
  }
  if (server.env !== undefined && !isStringRecord(server.env)) {
    return bad("mcp.config.add server.env must be an object of strings.");
  }
  const isolation = asRecord(server.isolation);
  if (server.isolation !== undefined && !isolation) {
    return bad("mcp.config.add server.isolation must be an object.");
  }
  if (isolation) {
    if (isolation.enabled !== undefined && typeof isolation.enabled !== "boolean") {
      return bad("mcp.config.add server.isolation.enabled must be a boolean.");
    }
    if (
      isolation.mode !== undefined &&
      isolation.mode !== "inherit" &&
      isolation.mode !== "restricted"
    ) {
      return bad("mcp.config.add server.isolation.mode must be inherit or restricted.");
    }
    if (isolation.runtimeRoot !== undefined && typeof isolation.runtimeRoot !== "string") {
      return bad("mcp.config.add server.isolation.runtimeRoot must be a string.");
    }
    if (
      isolation.preserveEnvKeys !== undefined &&
      !isStringArray(isolation.preserveEnvKeys)
    ) {
      return bad("mcp.config.add server.isolation.preserveEnvKeys must be an array of strings.");
    }
  }
  return { ok: true };
}

/** 校验工具调用输入，按 JSON 字节数限制请求体大小。 */
function validateToolCall(params: unknown): SchemaResult {
  const result = validateStringFields(params, ["sessionId", "toolName"]);
  if (!result.ok) {
    return result;
  }
  const input = asRecord(asRecord(params)?.input);
  if (!input) {
    return bad("tool.call params.input must be an object.");
  }
  const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  if (bytes > WS_MAX_TOOL_INPUT_BYTES) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      message: `tool.call input exceeds ${WS_MAX_TOOL_INPUT_BYTES} bytes.`,
    };
  }
  return { ok: true };
}

/** 校验审计日志 tail 参数。 */
function validateAuditTail(params: unknown): SchemaResult {
  const record = asRecord(params);
  if (!record) {
    return { ok: true };
  }
  if (
    record.limit !== undefined &&
    (typeof record.limit !== "number" || !Number.isInteger(record.limit) || record.limit <= 0)
  ) {
    return bad("audit.tail limit must be a positive integer.");
  }
  for (const key of ["type", "sessionId", "runId", "toolName"]) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      return bad(`audit.tail ${key} must be a string.`);
    }
  }
  return { ok: true };
}

/** 校验一组必填字符串字段。 */
function validateStringFields(params: unknown, fields: string[]): SchemaResult {
  const record = asRecord(params);
  if (!record) {
    return bad(`params must be an object with: ${fields.join(", ")}.`);
  }
  for (const field of fields) {
    if (!isNonEmptyString(record[field])) {
      return bad(`params.${field} is required and must be a non-empty string.`);
    }
  }
  return { ok: true };
}

/** 把未知输入安全收窄成普通对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 判断值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 判断值是否为非空且不超过上限的字符串。 */
function isBoundedString(value: unknown, maxChars: number): value is string {
  return isNonEmptyString(value) && value.length <= maxChars;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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

function validateSessionPurge(params: unknown): SchemaResult {
  const record = asRecord(params);
  if (!record) {
    return { ok: true };
  }
  if (
    record.keepRecent !== undefined &&
    (typeof record.keepRecent !== "number" || !Number.isInteger(record.keepRecent) || record.keepRecent < 0)
  ) {
    return bad("session.purge keepRecent must be a non-negative integer.");
  }
  if (
    record.olderThanDays !== undefined &&
    (typeof record.olderThanDays !== "number" || record.olderThanDays < 0)
  ) {
    return bad("session.purge olderThanDays must be a non-negative number.");
  }
  return { ok: true };
}

const UPDATABLE_RUNTIME_KEYS = new Set([
  "autoToolLoopEnabled",
  "autoReviewGraphEnabled",
  "model",
]);

function validateRuntimeUpdateConfig(params: unknown): SchemaResult {
  const record = asRecord(params);
  if (!record) {
    return bad("runtime.updateConfig params must be an object.");
  }
  let hasValid = false;
  for (const [key, value] of Object.entries(record)) {
    if (key === "model") {
      if (typeof value !== "string" || !normalizeGatewayModelName(value)) {
        return bad("runtime.updateConfig model must be mock, tokenplan, or minimax.");
      }
      hasValid = true;
    } else if (UPDATABLE_RUNTIME_KEYS.has(key)) {
      if (typeof value !== "boolean") {
        return bad(`runtime.updateConfig ${key} must be a boolean.`);
      }
      hasValid = true;
    }
  }
  if (!hasValid) {
    return bad("runtime.updateConfig requires at least one valid key.");
  }
  return { ok: true };
}

/** 构造 BAD_REQUEST 校验失败结果。 */
function bad(message: string): SchemaResult {
  return { ok: false, code: "BAD_REQUEST", message };
}
