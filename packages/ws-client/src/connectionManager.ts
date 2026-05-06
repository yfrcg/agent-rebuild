import type {
  GatewayClientOptions,
  ConnectionState,
  GatewayWsErrorCode,
  GatewayMethodResult,
} from "./types";

const GATEWAY_WS_PROTOCOL_VERSION = "1.0";

export type RawMessageHandler = (data: string) => void;
export type StateChangeHandler = (state: ConnectionState) => void;

export class ConnectionManager {
  private ws: WebSocket | null = null;
  private _state: ConnectionState = "disconnected";
  private _reconnectCount = 0;
  private _lastHeartbeat: string | null = null;
  private _lastError: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stateHandlers = new Set<StateChangeHandler>();
  private readonly messageHandlers = new Set<RawMessageHandler>();
  private readonly openHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<() => void>();
  private disposed = false;
  private connectIdCounter = 0;

  private readonly url: string;
  private readonly token?: string;
  private readonly clientName: string;
  private readonly reconnectEnabled: boolean;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private connectResolver: {
    resolve: (payload: GatewayMethodResult["connect"]) => void;
    reject: (err: Error) => void;
  } | null = null;

  constructor(options: GatewayClientOptions) {
    this.url = options.url ?? "ws://127.0.0.1:8787/v1/ws";
    this.token = options.token;
    this.clientName = options.clientName ?? "web-ui";
    this.reconnectEnabled = options.reconnect !== false;
    this.reconnectInitialMs = options.reconnectInitialMs ?? 1000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30000;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get lastHeartbeat(): string | null {
    return this._lastHeartbeat;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get reconnectCount(): number {
    return this._reconnectCount;
  }

  connect(
    resumeParams?: Array<{ sessionId: string; lastSeq: number }>
  ): Promise<GatewayMethodResult["connect"]> {
    if (this.disposed) {
      return Promise.reject(new Error("ConnectionManager disposed"));
    }

    this.disconnect();

    return new Promise<GatewayMethodResult["connect"]>((resolve, reject) => {
      this.connectResolver = { resolve, reject };
      this._reconnectCount = 0;
      this.doConnect(resumeParams);
    });
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.connectResolver = null;

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;

      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close(1000, "client disconnect");
      }

      this.ws = null;
    }

    this.setState("disconnected");
  }

  send(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.ws.send(data);
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.stateHandlers.clear();
    this.messageHandlers.clear();
    this.openHandlers.clear();
    this.closeHandlers.clear();
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  onMessage(handler: RawMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler);
    return () => {
      this.openHandlers.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  private doConnect(resumeParams?: Array<{ sessionId: string; lastSeq: number }>): void {
    this.setState(this._reconnectCount === 0 ? "connecting" : "reconnecting");

    try {
      const wsUrl = this.token
        ? `${this.url}?token=${encodeURIComponent(this.token)}`
        : this.url;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.openHandlers.forEach((h) => h());
        this.setState("authenticating");
        this.sendConnectRequest(resumeParams);
      };

      this.ws.onmessage = (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        this.messageHandlers.forEach((h) => h(data));
      };

      this.ws.onerror = () => {
        this._lastError = "WebSocket error";
      };

      this.ws.onclose = (event: CloseEvent) => {
        this.ws = null;
        this.closeHandlers.forEach((h) => h());

        if (event.code === 4001) {
          this._lastError = "Authentication failed";
          this.setState("disconnected");
          const resolver = this.connectResolver;
          this.connectResolver = null;
          resolver?.reject(new GatewayClientAuthError("Authentication failed"));
          return;
        }

        if (this._state === "authenticating") {
          const resolver = this.connectResolver;
          this.connectResolver = null;
          resolver?.reject(
            new Error(`Connection closed during authentication: ${event.reason}`)
          );
        }

        this.setState("disconnected");

        if (this.reconnectEnabled && !this.disposed) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this.setState("disconnected");
      const resolver = this.connectResolver;
      this.connectResolver = null;
      resolver?.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  handleConnectResponse(
    ok: boolean,
    payload?: unknown,
    error?: { code: GatewayWsErrorCode; message: string }
  ): void {
    if (this._state !== "authenticating") return;

    if (ok) {
      this.setState("ready");
      this._reconnectCount = 0;
      const resolver = this.connectResolver;
      this.connectResolver = null;
      resolver?.resolve(
        normalizeConnectPayload(payload)
      );
    } else {
      const code = error?.code;
      if (code === "UNAUTHORIZED" || code === "FORBIDDEN") {
        this._lastError = error?.message ?? "Authentication failed";
        this.disconnect();
        const resolver = this.connectResolver;
        this.connectResolver = null;
        resolver?.reject(new GatewayClientAuthError(this._lastError));
      } else {
        this._lastError = error?.message ?? "Connect failed";
        this.setState("disconnected");
        const resolver = this.connectResolver;
        this.connectResolver = null;
        resolver?.reject(new Error(this._lastError));
      }
    }
  }

  handleHeartbeat(serverTime: string): void {
    this._lastHeartbeat = serverTime;
  }

  private sendConnectRequest(
    resumeParams?: Array<{ sessionId: string; lastSeq: number }>
  ): void {
    const connectId = `web_connect_${Date.now()}_${++this.connectIdCounter}`;
    const resume =
      resumeParams && resumeParams.length > 0 ? resumeParams[0] : undefined;

    const request = {
      type: "req" as const,
      id: connectId,
      method: "connect" as const,
      params: {
        protocolVersion: GATEWAY_WS_PROTOCOL_VERSION,
        clientName: this.clientName,
        ...(resume ? { resume } : {}),
      },
    };

    try {
      this.send(JSON.stringify(request));
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const base = this.reconnectInitialMs;
    const max = this.reconnectMaxMs;
    const jitter = Math.random() * 0.3 + 0.85;
    const delay = Math.min(base * Math.pow(2, this._reconnectCount) * jitter, max);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._reconnectCount++;
      this.doConnect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch {
        // handler errors are non-fatal
      }
    }
  }
}

function normalizeConnectPayload(payload: unknown): GatewayMethodResult["connect"] {
  if (!payload || typeof payload !== "object") {
    return {
      clientId: "",
      protocolVersion: GATEWAY_WS_PROTOCOL_VERSION,
    };
  }

  const record = payload as Record<string, unknown>;
  return {
    clientId: String(record.clientId ?? ""),
    protocolVersion: String(record.protocolVersion ?? GATEWAY_WS_PROTOCOL_VERSION),
    serverVersion:
      typeof record.serverVersion === "string" ? record.serverVersion : undefined,
    serverTime: typeof record.serverTime === "string" ? record.serverTime : undefined,
    capabilities:
      record.capabilities && typeof record.capabilities === "object"
        ? (record.capabilities as Record<string, boolean>)
        : undefined,
  };
}

export class GatewayClientAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayClientAuthError";
  }
}
