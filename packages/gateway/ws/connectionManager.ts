
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

import type { WsEvent, WsResponse, WsServerMessage } from "./protocol";
import type { ReplayBuffer } from "./replayBuffer";
import type { GatewayWsMetricsCollector } from "./metrics";

const WS_OPEN = 1;

/**
 * 单个 WebSocket 客户端连接的运行时状态。
 *
 * 除了底层 socket，这里还记录订阅会话、事件序号、心跳状态和丢弃事件数量，
 * 这些字段共同支撑事件广播、断线恢复和慢客户端背压保护。
 */
export interface WsClientConnection {
  clientId: string;
  socket: WebSocket;
  connectedAt: string;
  lastSeenAt: string;
  subscribedSessionIds: Set<string>;
  nextSeq: number;
  alive: boolean;
  droppedEvents: number;
}

/**
 * 管理当前所有 WS 客户端连接。
 *
 * 它负责分配 clientId、记录订阅关系、发送响应/事件、写入回放缓冲，
 * 并在客户端消费过慢时丢弃低价值事件或关闭连接，避免拖垮网关进程。
 */
export class ConnectionManager {
  private readonly clients = new Map<string, WsClientConnection>();
  private readonly maxBufferedAmount: number;
  private readonly maxPendingEvents: number;

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(
    private readonly replayBuffer?: ReplayBuffer,
    options?: {
      maxBufferedAmount?: number;
      maxPendingEvents?: number;
      metrics?: GatewayWsMetricsCollector;
    }
  ) {
    this.maxBufferedAmount = options?.maxBufferedAmount ?? 8 * 1024 * 1024;
    this.maxPendingEvents = options?.maxPendingEvents ?? 1000;
    this.metrics = options?.metrics;
  }

  private readonly metrics?: GatewayWsMetricsCollector;

  /** 注册一个新连接，并初始化该客户端的事件序号和心跳状态。 */
  add(socket: WebSocket): WsClientConnection {
    const now = new Date().toISOString();
    const client: WsClientConnection = {
      clientId: `client_${randomUUID()}`,
      socket,
      connectedAt: now,
      lastSeenAt: now,
      subscribedSessionIds: new Set<string>(),
      nextSeq: 1,
      alive: true,
      droppedEvents: 0,
    };
    this.clients.set(client.clientId, client);
    return client;
  }

  /** 移除连接引用；调用方负责在必要时关闭底层 socket。 */
  remove(clientId: string): void {
    this.clients.delete(clientId);
  }

  /** 读取指定客户端连接，路由层会用它确认请求来源仍然在线。 */
  get(clientId: string): WsClientConnection | undefined {
    return this.clients.get(clientId);
  }

  /** 返回当前连接快照，避免外部直接操作内部 Map。 */
  list(): WsClientConnection[] {
    return Array.from(this.clients.values());
  }

  /** 订阅会话事件；同一客户端可以同时订阅多个会话。 */
  subscribe(clientId: string, sessionId: string): void {
    this.clients.get(clientId)?.subscribedSessionIds.add(sessionId);
  }

  /** 取消会话订阅，后续广播不会再发送给该客户端。 */
  unsubscribe(clientId: string, sessionId: string): void {
    this.clients.get(clientId)?.subscribedSessionIds.delete(sessionId);
  }

  /** 向指定客户端发送请求响应。 */
  sendResponse(clientId: string, response: WsResponse): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }
    if (this.send(client, response)) {
      this.metrics?.messageSent();
    }
  }

  /**
   * 向指定客户端发送服务端事件。
   *
   * 事件会先补齐 `seq` 和 `createdAt`，再写入回放缓冲；
   * 如果客户端已经出现背压，则低优先级事件会被直接丢弃。
   */
  sendEvent(clientId: string, event: Omit<WsEvent, "seq" | "createdAt">): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    const fullEvent = this.replayBuffer?.appendSessionEvent({
      ...event,
      type: "event",
      createdAt: new Date().toISOString(),
    }) ?? {
      ...event,
      type: "event" as const,
      seq: client.nextSeq,
      createdAt: new Date().toISOString(),
    };
    client.nextSeq = Math.max(client.nextSeq + 1, fullEvent.seq + 1);
    this.replayBuffer?.appendClient(clientId, fullEvent);

    if (this.shouldDropEvent(client, fullEvent)) {
      client.droppedEvents += 1;
      return;
    }

    if (this.send(client, fullEvent)) {
      this.metrics?.eventSent();
    }
  }

  /** 把一个事件广播给所有订阅了该会话的客户端。 */
  broadcastToSession(
    sessionId: string,
    event: Omit<WsEvent, "seq" | "createdAt">
  ): void {
    for (const client of this.clients.values()) {
      if (client.subscribedSessionIds.has(sessionId)) {
        this.sendEvent(client.clientId, {
          ...event,
          sessionId: event.sessionId ?? sessionId,
        });
      }
    }
  }

  /** 标记客户端心跳正常，同时刷新最后活跃时间。 */
  markAlive(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }
    client.alive = true;
    client.lastSeenAt = new Date().toISOString();
  }

  /** 标记客户端刚刚发送过消息，用于连接活跃度观测。 */
  markSeen(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }
    client.lastSeenAt = new Date().toISOString();
  }

  /**
   * 根据客户端提供的最后事件序号补发会话事件。
   *
   * 如果服务端已经没有该会话的回放历史，返回 `false`，
   * 调用方会通知客户端做完整状态重同步。
   */
  replaySessionEvents(clientId: string, sessionId: string, lastSeq: number): boolean {
    const client = this.clients.get(clientId);
    if (!client || !this.replayBuffer?.hasSessionHistory(sessionId)) {
      return false;
    }
    const events = this.replayBuffer.getSessionSince(sessionId, lastSeq);
    for (const event of events) {
      if (this.send(client, event)) {
        this.metrics?.eventSent();
      }
    }
    return true;
  }

  /** 安全发送一条消息；断开的客户端不会把异常抛到主流程。 */
  private send(client: WsClientConnection, message: WsServerMessage): boolean {
    try {
      if ((client.socket as { readyState?: number }).readyState !== WS_OPEN) {
        return false;
      }
      client.socket.send(JSON.stringify(message));
      return true;
    } catch {
      // A broken client must not crash the gateway.
      return false;
    }
  }

  /**
   * 判断是否需要丢弃事件或关闭慢客户端。
   *
   * `chat.delta` 和心跳是可恢复的低价值事件，背压时优先丢弃；
   * 其他事件通常影响状态一致性，因此超过阈值后直接关闭连接。
   */
  private shouldDropEvent(client: WsClientConnection, event: WsEvent): boolean {
    const bufferedAmount = (client.socket as { bufferedAmount?: number }).bufferedAmount ?? 0;
    if (bufferedAmount <= this.maxBufferedAmount && client.droppedEvents <= this.maxPendingEvents) {
      return false;
    }
    if (event.event === "chat.delta" || event.event === "heartbeat") {
      return true;
    }
    try {
      client.socket.close(1013, "client backpressure");
    } catch {
      // ignore
    }
    return true;
  }
}
