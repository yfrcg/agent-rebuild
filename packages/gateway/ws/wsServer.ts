
import * as http from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";

import type { AuditEventType } from "../../audit/types";
import type { GatewayRuntime } from "../runtime";
import { authenticateWsUpgrade, loadGatewayWsAuthConfig } from "./auth";
import { ConnectionManager } from "./connectionManager";
import { IdempotencyStore } from "./idempotencyStore";
import { GatewayWsMetricsCollector } from "./metrics";
import { fail, isWsRequest } from "./protocol";
import { ReplayBuffer } from "./replayBuffer";
import { RunManager } from "./runManager";
import { handleWsRequest } from "./router";

const WS_PATH = "/v1/ws";
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * WS 服务启动后的句柄。
 *
 * `url` 供 smoke 测试或本地前端直接连接，`close()` 负责优雅关闭连接、
 * 等待运行任务收尾并释放 Gateway 运行时资源。
 */
export interface GatewayWsServerHandle {
  url: string;
  /** 方法 `close`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
  close(): Promise<void>;
}

/**
 * 启动 Gateway WebSocket 服务。
 *
 * 这里负责 HTTP upgrade、鉴权、连接上限、消息限流、心跳、事件回放、
 * 异步运行任务和优雅关闭；具体业务方法由 `router.ts` 处理。
 */
export async function startGatewayWsServer(
  runtime: GatewayRuntime
): Promise<GatewayWsServerHandle> {
  const authConfig = loadGatewayWsAuthConfig();
  const metrics = new GatewayWsMetricsCollector();
  const replayBuffer = new ReplayBuffer({ maxEvents: 1000 });
  const connections = new ConnectionManager(replayBuffer, {
    maxBufferedAmount: authConfig.maxBufferedAmount,
    maxPendingEvents: authConfig.maxPendingEvents,
    metrics,
  });
  const runs = new RunManager();
  const idempotency = new IdempotencyStore();
  const rateLimiters = new Map<string, { windowStartedAt: number; count: number }>();

  const server = http.createServer();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: authConfig.maxMessageBytes,
  });

  server.on("upgrade", (request, socket, head) => {
    const parsedUrl = safeUrl(request.url);
    if (parsedUrl?.pathname !== WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const auth = authenticateWsUpgrade({
      url: request.url,
      headers: request.headers,
      config: authConfig,
    });
    if (!auth.ok) {
      metrics.authFailure();
      void writeWsAudit(runtime, "ws.auth.failed", {
        code: auth.code,
        message: auth.message,
      });
      const status = auth.code === "UNAUTHORIZED" ? 401 : 403;
      socket.write(`HTTP/1.1 ${status} ${auth.code}\r\n\r\n`);
      socket.destroy();
      return;
    }

    if (connections.list().length >= authConfig.maxConnections) {
      metrics.rateLimitedRequest();
      socket.write("HTTP/1.1 503 Too Many Connections\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket: WebSocket) => {
    const client = connections.add(socket);
    metrics.connectionOpened();
    void writeWsAudit(runtime, "ws.connected", {
      clientId: client.clientId,
      connectedAt: client.connectedAt,
    });

    socket.on("pong", () => {
      connections.markAlive(client.clientId);
    });

    socket.on("message", (data) => {
      const raw = data.toString();
      metrics.messageReceived();
      connections.markSeen(client.clientId);
      if (Buffer.byteLength(raw, "utf8") > authConfig.maxMessageBytes) {
        connections.sendResponse(
          client.clientId,
          fail("unknown", "PAYLOAD_TOO_LARGE", "WebSocket message exceeds max size.")
        );
        return;
      }
      if (isRateLimited(client.clientId, rateLimiters, authConfig.rateLimitWindowMs, authConfig.rateLimitMaxMessages)) {
        metrics.rateLimitedRequest();
        connections.sendResponse(
          client.clientId,
          fail("unknown", "RATE_LIMITED", "Too many WebSocket messages.")
        );
        void writeWsAudit(runtime, "ws.rate_limited", { clientId: client.clientId });
        return;
      }
      void handleMessage(socket, client.clientId, raw, {
        runtime,
        connections,
        runs,
        idempotency,
        metrics,
        limits: authConfig,
      });
    });

    socket.on("close", () => {
      connections.remove(client.clientId);
      replayBuffer.clear(client.clientId);
      metrics.connectionClosed();
      void writeWsAudit(runtime, "ws.disconnected", { clientId: client.clientId });
    });

    socket.on("error", () => {
      connections.remove(client.clientId);
      metrics.connectionClosed();
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of connections.list()) {
      if (!client.alive) {
        try {
          client.socket.terminate();
        } catch {
          // ignore broken client sockets
        }
        connections.remove(client.clientId);
        continue;
      }

      client.alive = false;
      try {
        client.socket.ping();
        connections.sendEvent(client.clientId, {
          type: "event",
          event: "heartbeat",
          payload: { serverTime: new Date().toISOString() },
        });
      } catch {
        connections.remove(client.clientId);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  let closed = false;
  /**
   * 优雅关闭 WS 服务。
   *
   * 先广播 server.shutdown，让客户端停止发新请求；
   * 再等待运行任务在超时时间内结束，超时后取消仍在运行的任务并关闭连接。
   */
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    for (const client of connections.list()) {
      connections.sendEvent(client.clientId, {
        type: "event",
        event: "server.shutdown",
        payload: {
          reason: "Gateway is shutting down.",
          timeoutMs: authConfig.shutdownTimeoutMs,
        },
      });
    }

    const deadline = Date.now() + authConfig.shutdownTimeoutMs;
    while (runs.countRunning() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (runs.countRunning() > 0) {
      for (const run of runs.listRuns().filter((item) => item.status === "running")) {
        runs.cancelRun(run.runId);
      }
    }

    for (const client of connections.list()) {
      try {
        client.socket.close();
      } catch {
        // ignore
      }
      connections.remove(client.clientId);
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.close();
  };

  await new Promise<void>((resolve) => {
    server.listen(authConfig.port, authConfig.host, resolve);
  });

  console.log(
    `[gateway:ws] listening on ws://${authConfig.host}:${authConfig.port}${WS_PATH}`
  );
  console.log(`[gateway:ws] auth token: ${authConfig.token ? "enabled" : "disabled"}`);

  return {
    url: `ws://${authConfig.host}:${authConfig.port}${WS_PATH}`,
    close,
  };
}

/**
 * 解析并处理单条客户端消息。
 *
 * 这个函数只负责 JSON 解析、协议形状校验、审计记录和异常兜底，
 * 业务分发统一交给 `handleWsRequest()`。
 */
async function handleMessage(
  socket: WebSocket,
  clientId: string,
  raw: string,
  context: Parameters<typeof handleWsRequest>[2]
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeSend(socket, fail("unknown", "BAD_REQUEST", "Invalid JSON message."));
    return;
  }

  if (!isWsRequest(parsed)) {
    const id = readMessageId(parsed) ?? "unknown";
    safeSend(socket, fail(id, "BAD_REQUEST", "Invalid WebSocket request."));
    return;
  }

  const client = context.connections.get(clientId);
  if (!client) {
    return;
  }

  try {
    await writeWsAudit(context.runtime, "ws.request.received", {
      clientId,
      requestId: parsed.id,
      method: parsed.method,
    });
    const response = await handleWsRequest(client, parsed, context);
    if (response) {
      context.connections.sendResponse(clientId, response);
    }
  } catch (err) {
    await writeWsAudit(context.runtime, "ws.request.failed", {
      clientId,
      requestId: parsed.id,
      method: parsed.method,
      error: err instanceof Error ? err.message : String(err),
    });
    context.connections.sendResponse(
      clientId,
      fail(
        parsed.id,
        "INTERNAL_ERROR",
        err instanceof Error ? err.message : String(err)
      )
    );
  }
}

/**
 * 简单的客户端级滑动窗口限流。
 *
 * 限流维度是 clientId，不是 IP；这是因为连接已经通过鉴权和连接上限过滤，
 * 这里主要防止单个客户端在已建立连接内刷爆路由层。
 */
function isRateLimited(
  clientId: string,
  limiters: Map<string, { windowStartedAt: number; count: number }>,
  windowMs: number,
  maxMessages: number
): boolean {
  const now = Date.now();
  const current = limiters.get(clientId);
  if (!current || now - current.windowStartedAt > windowMs) {
    limiters.set(clientId, { windowStartedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > maxMessages;
}

/** 写入 WS 相关审计事件。 */
async function writeWsAudit(
  runtime: GatewayRuntime,
  type: AuditEventType,
  data: Record<string, unknown>
): Promise<void> {
  await runtime.auditLogger.log({
    id: `${type}-${Date.now()}-${randomBytes(6).toString("hex")}`,
    type,
    message: type,
    createdAt: new Date().toISOString(),
    data,
  });
}

/** 安全发送兜底响应，避免坏连接上的 send 异常冒泡。 */
function safeSend(socket: WebSocket, message: unknown): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // ignore broken clients
  }
}

/** 安全解析 upgrade URL，非法 URL 直接视为无法匹配路由。 */
function safeUrl(url: string | undefined): URL | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url, "ws://localhost");
  } catch {
    return undefined;
  }
}

/** 从不合法消息中尽量读出 id，让 BAD_REQUEST 响应可被客户端匹配。 */
function readMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() !== "" ? id : undefined;
}
