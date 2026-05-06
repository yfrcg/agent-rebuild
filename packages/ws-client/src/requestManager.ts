import type { GatewayWsMethod, WsRequest, WsResponse } from "./types";

const IDEMPOTENCY_METHODS = new Set<GatewayWsMethod>([
  "chat.send",
  "chat.cancel",
  "tool.call",
  "memory.write",
  "session.create",
  "session.rename",
  "session.bindProject",
  "approval.confirm",
  "approval.reject",
]);

interface PendingRequest {
  resolve: (response: WsResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RequestManager {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private idCounter = 0;

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 30000;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  generateId(method: string): string {
    return `web_${method}_${Date.now()}_${(++this.idCounter).toString(36)}`;
  }

  shouldInjectIdempotencyKey(method: GatewayWsMethod): boolean {
    return IDEMPOTENCY_METHODS.has(method);
  }

  generateIdempotencyKey(method: string): string {
    return `web_ik_${method}_${Date.now()}_${(++this.idCounter).toString(36)}`;
  }

  createRequest<M extends GatewayWsMethod>(
    method: M,
    params?: unknown,
    idempotencyKey?: string
  ): { request: WsRequest; promise: Promise<WsResponse> } {
    const id = this.generateId(method);
    const request: WsRequest = {
      type: "req",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };

    const promise = new Promise<WsResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestTimeoutError(method, this.timeoutMs));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });

    return { request, promise };
  }

  resolve(id: string, response: WsResponse): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;

    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(response);
    return true;
  }

  rejectAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  dispose(): void {
    this.rejectAll(new Error("RequestManager disposed"));
  }
}

export class RequestTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number
  ) {
    super(`Request ${method} timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

export class ConnectionClosedError extends Error {
  constructor() {
    super("WebSocket connection closed while requests were pending");
    this.name = "ConnectionClosedError";
  }
}
