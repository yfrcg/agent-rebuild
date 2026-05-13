/**
 * ?????CS336 ???
 * ???packages/ws-client/src/eventDispatcher.ts
 * ???WebSocket ??? SDK?
 * ????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import type { GatewayWsEvent, WsEvent, GatewayEventPayload } from "./types";

type EventHandler<E extends GatewayWsEvent = GatewayWsEvent> = (
  payload: GatewayEventPayload[E],
  raw: WsEvent
) => void;

type DeltaHandler = (events: WsEvent[]) => void;
type ResyncHandler = (event: WsEvent) => void;

export class EventDispatcher {
  private readonly listeners = new Map<GatewayWsEvent, Set<EventHandler>>();
  private readonly deltaListeners = new Set<DeltaHandler>();
  private readonly resyncListeners = new Set<ResyncHandler>();
  private readonly deltaBuffer: WsEvent[] = [];
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly deltaBatchMs: number;
  private readonly lastSeqBySession = new Map<string, number>();
  private disposed = false;

  constructor(options?: { deltaBatchMs?: number }) {
    this.deltaBatchMs = options?.deltaBatchMs ?? 50;
  }

  dispatch(event: WsEvent): void {
    if (this.disposed) return;

    if (event.sessionId) {
      const currentSeq = this.lastSeqBySession.get(event.sessionId) ?? 0;
      if (event.seq > currentSeq) {
        this.lastSeqBySession.set(event.sessionId, event.seq);
      }
    }

    if (event.event === "chat.delta") {
      this.deltaBuffer.push(event);
      this.scheduleFlushDeltas();
      return;
    }

    if (event.event === "state.resync_required") {
      for (const handler of this.resyncListeners) {
        try {
          handler(event);
        } catch {
          // handler errors are non-fatal
        }
      }
    }

    this.dispatchEvent(event);
  }

  on<E extends GatewayWsEvent>(
    event: E,
    handler: EventHandler<E>
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as EventHandler);
    return () => {
      set!.delete(handler as EventHandler);
      if (set!.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  onDelta(handler: DeltaHandler): () => void {
    this.deltaListeners.add(handler);
    return () => {
      this.deltaListeners.delete(handler);
    };
  }

  onResyncRequired(handler: ResyncHandler): () => void {
    this.resyncListeners.add(handler);
    return () => {
      this.resyncListeners.delete(handler);
    };
  }

  setLastSeq(sessionId: string, seq: number): void {
    const current = this.lastSeqBySession.get(sessionId) ?? 0;
    if (seq > current) {
      this.lastSeqBySession.set(sessionId, seq);
    }
  }

  getLastSeq(sessionId: string): number {
    return this.lastSeqBySession.get(sessionId) ?? 0;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.deltaListeners.clear();
    this.resyncListeners.clear();
    this.lastSeqBySession.clear();
    this.deltaBuffer.length = 0;
    this.clearDeltaTimer();
  }

  private dispatchEvent(event: WsEvent): void {
    const handlers = this.listeners.get(event.event);
    if (!handlers || handlers.size === 0) return;

    for (const handler of handlers) {
      try {
        handler(event.payload as GatewayEventPayload[typeof event.event], event);
      } catch {
        // handler errors are non-fatal
      }
    }
  }

  private scheduleFlushDeltas(): void {
    if (this.deltaTimer !== null) return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = null;
      this.flushDeltas();
    }, this.deltaBatchMs);
  }

  private flushDeltas(): void {
    if (this.deltaBuffer.length === 0) return;

    const batch = this.deltaBuffer.splice(0);

    for (const event of batch) {
      this.dispatchEvent(event);
    }

    for (const handler of this.deltaListeners) {
      try {
        handler(batch);
      } catch {
        // handler errors are non-fatal
      }
    }
  }

  private clearDeltaTimer(): void {
    if (this.deltaTimer !== null) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
  }
}
