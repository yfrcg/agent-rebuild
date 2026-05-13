/**
 * ?????CS336 ???
 * ???packages/ws-client/src/types.ts
 * ???WebSocket ??? SDK?
 * ????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import type {
  GatewayWsMethod,
  GatewayWsEvent,
  GatewayWsErrorCode,
  WsRequest,
  WsResponse,
  WsEvent,
} from "../../gateway/ws/protocol";

export type { GatewayWsMethod, GatewayWsEvent, GatewayWsErrorCode, WsRequest, WsResponse, WsEvent };

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "ready"
  | "reconnecting";

export interface GatewayClientOptions {
  url?: string;
  token?: string;
  clientName?: string;
  reconnect?: boolean;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  requestTimeoutMs?: number;
  deltaBatchMs?: number;
}

export interface GatewayMethodParams {
  connect: {
    protocolVersion?: string;
    clientName?: string;
    resume?: { sessionId: string; lastSeq: number };
  };
  ping: Record<string, never>;
  "runtime.status": Record<string, never>;
  "runtime.updateConfig": {
    autoToolLoopEnabled?: boolean;
    autoReviewGraphEnabled?: boolean;
    model?: "mock" | "tokenplan" | "minimax";
  };
  "session.list": Record<string, never>;
  "session.get": { sessionId?: string };
  "session.create": { name?: string };
  "session.rename": { name: string; sessionId?: string };
  "session.delete": { sessionId: string };
  "session.purge": { keepRecent?: number; olderThanDays?: number };
  "session.usage": { sessionId: string };
  "session.bindProject": { sessionId: string; projectDir: string };
  "session.getTranscript": { sessionId: string };
  "chat.send": { sessionId: string; input: string };
  "chat.cancel": { runId: string };
  "memory.search": { query: string };
  "memory.write": {
    sessionId: string;
    content: string;
    scope?: "daily" | "long_term" | "auto";
  };
  "mcp.status": Record<string, never>;
  "mcp.tools": Record<string, never>;
  "mcp.config.add": {
    server: {
      id: string;
      name?: string;
      enabled?: boolean;
      transport?: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      toolNamePrefix?: string;
      isolation?: {
        enabled?: boolean;
        mode?: "inherit" | "restricted";
        runtimeRoot?: string;
        preserveEnvKeys?: string[];
      };
    };
  };
  "skills.list": Record<string, never>;
  "skills.current": { sessionId: string };
  "skills.use": { sessionId: string; skillName: string };
  "skills.clear": { sessionId: string };
  "tool.list": Record<string, never>;
  "tool.call": {
    sessionId: string;
    toolName: string;
    input: Record<string, unknown>;
  };
  "approval.list": { sessionId: string };
  "approval.confirm": { sessionId: string; token: string };
  "approval.reject": { sessionId: string; token: string };
  "audit.tail": {
    limit?: number;
    type?: string;
    sessionId?: string;
    runId?: string;
    toolName?: string;
  };
}

export interface GatewayMethodResult {
  connect: {
    clientId: string;
    protocolVersion: string;
    serverVersion?: string;
    serverTime?: string;
    capabilities?: Record<string, boolean>;
  };
  ping: { pong: true; serverTime: string };
  "runtime.status": Record<string, unknown>;
  "runtime.updateConfig": Record<string, unknown>;
  "session.list": Array<Record<string, unknown>>;
  "session.get": Record<string, unknown>;
  "session.create": Record<string, unknown> & { id?: string; sessionId?: string };
  "session.rename": Record<string, unknown>;
  "session.delete": { deleted: boolean; sessionId: string };
  "session.purge": { deleted: number; kept: number };
  "session.usage": {
    summary: { totalPromptTokens: number; totalCompletionTokens: number; totalTokens: number; totalCostCents: number; requestCount: number };
    records: Array<Record<string, unknown>>;
  };
  "session.bindProject": {
    sessionId: string;
    projectDir: string;
    permission: string;
    allowedReadRoots: string[];
    allowedWriteRoots: string[];
  };
  "session.getTranscript": { sessionId: string; messages: unknown[] };
  "chat.send": { runId: string; sessionId: string; requestId: string };
  "chat.cancel": { cancelled: true; runId: string };
  "memory.search": {
    results: Array<{
      chunkId: string;
      fileId: string;
      section: string;
      filePath: string;
      score: number;
      content: string;
    }>;
  };
  "memory.write": { success: true; filePath: string; scope: string };
  "mcp.status": {
    statuses: Array<Record<string, unknown>>;
    total: number;
  };
  "mcp.tools": {
    tools: Array<Record<string, unknown>>;
    total: number;
  };
  "mcp.config.add": {
    server: Record<string, unknown>;
    statuses: Array<Record<string, unknown>>;
    configPath: string;
  };
  "skills.list": {
    skills: Array<Record<string, unknown>>;
    total: number;
  };
  "skills.current": {
    sessionId: string;
    activeSkills: string[];
  };
  "skills.use": {
    sessionId: string;
    activeSkills: string[];
    activated: string;
  };
  "skills.clear": {
    sessionId: string;
    activeSkills: string[];
  };
  "tool.list": {
    tools: Array<{
      name: string;
      description?: string;
      category?: string;
      riskLevel?: string;
      source?: string;
    }>;
    total: number;
  };
  "tool.call": {
    toolCallId: string;
    output: unknown;
    status: string;
    durationMs: number;
  };
  "approval.list": {
    approvals: Array<{
      token: string;
      toolName: string;
      input: unknown;
      createdAt: string;
      expiresAt: string;
      message?: string;
      sessionId?: string;
    }>;
  };
  "approval.confirm": { consumed: true };
  "approval.reject": { consumed: true };
  "audit.tail": unknown[] | { events?: unknown[]; entries?: unknown[] };
}

export interface GatewayEventPayload {
  connected: {
    clientId: string;
    protocolVersion: string;
    serverTime: string;
  };
  heartbeat: { serverTime: string };
  "run.started": { sessionId: string; requestId?: string };
  "run.progress": { sessionId: string; message?: string };
  "run.finished": { sessionId: string; requestId?: string };
  "run.failed": { sessionId: string; error?: string };
  "run.cancelled": { sessionId: string };
  "chat.completed": {
    responseId?: string;
    text?: string;
    memoryUsed?: unknown[];
    toolCalls?: unknown[];
    debug?: unknown;
    error?: string;
    createdAt?: string;
  };
  "chat.delta": { text?: string; delta?: string };
  "tool.started": {
    toolCallId?: string;
    toolName?: string;
    sessionId?: string;
  };
  "tool.finished": {
    toolCallId?: string;
    toolName?: string;
    output?: unknown;
    durationMs?: number;
    sessionId?: string;
  };
  "tool.failed": {
    toolCallId?: string;
    toolName?: string;
    error?: string;
    sessionId?: string;
  };
  "tool.denied": {
    toolCallId?: string;
    toolName?: string;
    reason?: string;
    sessionId?: string;
  };
  "approval.required": {
    token?: string;
    toolName?: string;
    input?: unknown;
    expiresAt?: string;
    message?: string;
    sessionId?: string;
  };
  "approval.confirmed": { token?: string; sessionId?: string };
  "approval.rejected": { token?: string; sessionId?: string };
  "session.updated": Record<string, unknown>;
  "audit.append": Record<string, unknown>;
  "server.shutdown": { reason?: string; restartMs?: number };
  "state.resync_required": { reason?: string; sessionId?: string };
  [key: string]: unknown;
}

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayWsErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
