
import type { WsEvent } from "./protocol";

/**
 * WebSocket 事件回放缓冲。
 *
 * 它同时按客户端和会话保存最近事件：客户端维度用于诊断或点对点补发，
 * 会话维度用于断线重连后根据 `lastSeq` 补发会话内事件。
 */
export class ReplayBuffer {
  private readonly maxEvents: number;
  private readonly eventsByClient = new Map<string, WsEvent[]>();
  private readonly eventsBySession = new Map<string, WsEvent[]>();
  private nextGlobalSeq = 1;

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(options?: { maxEvents?: number }) {
    this.maxEvents = options?.maxEvents ?? 200;
  }

  /** 同时写入客户端和会话缓冲，适合已经带完整序号的事件。 */
  append(clientId: string, event: WsEvent): void {
    this.appendClient(clientId, event);
    if (event.sessionId) {
      this.appendSession(event.sessionId, event);
    }
  }

  /**
   * 为会话事件补齐全局递增序号并写入会话缓冲。
   *
   * 全局序号能让不同客户端看到一致的事件顺序，
   * 也避免每个连接单独编号造成恢复语义不一致。
   */
  appendSessionEvent(event: Omit<WsEvent, "seq"> & { seq?: number }): WsEvent {
    const fullEvent: WsEvent = {
      ...event,
      type: "event",
      seq: event.seq ?? this.nextGlobalSeq,
    };
    this.nextGlobalSeq = Math.max(this.nextGlobalSeq, fullEvent.seq + 1);
    if (fullEvent.sessionId) {
      this.appendSession(fullEvent.sessionId, fullEvent);
    }
    return fullEvent;
  }

  /** 读取某个会话在指定序号之后的所有可回放事件。 */
  getSessionSince(sessionId: string, lastSeq: number): WsEvent[] {
    return (this.eventsBySession.get(sessionId) ?? []).filter(
      (event) => event.seq > lastSeq
    );
  }

  /** 判断服务端是否仍保存该会话的回放历史。 */
  hasSessionHistory(sessionId: string): boolean {
    return this.eventsBySession.has(sessionId);
  }

  /** 写入客户端维度缓冲，并按最大容量裁掉最旧事件。 */
  appendClient(clientId: string, event: WsEvent): void {
    const events = this.eventsByClient.get(clientId) ?? [];
    events.push(event);
    if (events.length > this.maxEvents) {
      events.splice(0, events.length - this.maxEvents);
    }
    this.eventsByClient.set(clientId, events);
  }

  /** 写入会话维度缓冲，并按最大容量裁掉最旧事件。 */
  private appendSession(sessionId: string, event: WsEvent): void {
    const events = this.eventsBySession.get(sessionId) ?? [];
    events.push(event);
    if (events.length > this.maxEvents) {
      events.splice(0, events.length - this.maxEvents);
    }
    this.eventsBySession.set(sessionId, events);
  }

  /** 读取某个客户端在指定序号之后的事件。 */
  getSince(clientId: string, lastSeq: number): WsEvent[] {
    return (this.eventsByClient.get(clientId) ?? []).filter(
      (event) => event.seq > lastSeq
    );
  }

  /** 客户端断开后清理它的点对点缓冲。 */
  clear(clientId: string): void {
    this.eventsByClient.delete(clientId);
  }
}
