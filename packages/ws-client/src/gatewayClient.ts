import type {
  GatewayClientOptions,
  GatewayWsMethod,
  GatewayWsEvent,
  GatewayMethodParams,
  GatewayMethodResult,
  GatewayEventPayload,
  WsResponse,
  WsEvent,
} from "./types";
import { GatewayError, ConnectionState } from "./types";
import { ConnectionManager } from "./connectionManager";
import { RequestManager, ConnectionClosedError } from "./requestManager";
import { EventDispatcher } from "./eventDispatcher";
import { ResumeManager } from "./resumeManager";

const DEFAULT_URL = "ws://127.0.0.1:8787/v1/ws";
const DEFAULT_CLIENT_NAME = "web-ui";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_DELTA_BATCH_MS = 50;

export class GatewayClient {
  private readonly connection: ConnectionManager;
  private readonly requests: RequestManager;
  private readonly events: EventDispatcher;
  private readonly resume: ResumeManager;
  private connectPromise: Promise<GatewayMethodResult["connect"]> | null = null;
  private resyncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly capabilities = new Map<string, boolean>();
  private disposed = false;

  constructor(options?: GatewayClientOptions) {
    const opts = options ?? {};

    this.requests = new RequestManager({
      timeoutMs: opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    this.connection = new ConnectionManager({
      url: opts.url ?? DEFAULT_URL,
      token: opts.token,
      clientName: opts.clientName ?? DEFAULT_CLIENT_NAME,
      reconnect: opts.reconnect,
      reconnectInitialMs: opts.reconnectInitialMs,
      reconnectMaxMs: opts.reconnectMaxMs,
    });

    this.events = new EventDispatcher({
      deltaBatchMs: opts.deltaBatchMs ?? DEFAULT_DELTA_BATCH_MS,
    });

    this.resume = new ResumeManager({
      requestManager: this.requests,
    });

    this.setupInternalHandlers();
  }

  get connectionState(): ConnectionState {
    return this.connection.state;
  }

  get isConnected(): boolean {
    return this.connection.state === "ready";
  }

  get lastHeartbeat(): string | null {
    return this.connection.lastHeartbeat;
  }

  get lastError(): string | null {
    return this.connection.lastError;
  }

  get reconnectCount(): number {
    return this.connection.reconnectCount;
  }

  getCapability(name: string): boolean {
    return this.capabilities.get(name) ?? false;
  }

  connect(): Promise<GatewayMethodResult["connect"]> {
    if (this.disposed) {
      return Promise.reject(new Error("GatewayClient disposed"));
    }

    const resumeParams = this.resume.buildResumeParams();

    this.connectPromise = this.connection.connect(resumeParams).then((result) => {
      if (result.capabilities) {
        for (const [key, value] of Object.entries(result.capabilities)) {
          this.capabilities.set(key, value);
        }
      }
      return result;
    });

    return this.connectPromise;
  }

  disconnect(): void {
    this.connection.disconnect();
    this.requests.rejectAll(new ConnectionClosedError());
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.connection.dispose();
    this.requests.dispose();
    this.events.dispose();
    this.resume.dispose();
    if (this.resyncDebounceTimer !== null) {
      clearTimeout(this.resyncDebounceTimer);
      this.resyncDebounceTimer = null;
    }
  }

  on<E extends GatewayWsEvent>(
    event: E,
    handler: (payload: GatewayEventPayload[E], raw: WsEvent) => void
  ): () => void {
    return this.events.on(event, handler);
  }

  onDelta(handler: (events: WsEvent[]) => void): () => void {
    return this.events.onDelta(handler);
  }

  onConnectionStateChange(
    handler: (state: ConnectionState) => void
  ): () => void {
    return this.connection.onStateChange(handler);
  }

  async request<M extends GatewayWsMethod>(
    method: M,
    params?: GatewayMethodParams[M]
  ): Promise<GatewayMethodResult[M]> {
    if (this.connection.state !== "ready") {
      throw new Error(
        `Cannot send request: connection state is ${this.connection.state}`
      );
    }

    const idempotencyKey = this.requests.shouldInjectIdempotencyKey(method)
      ? this.requests.generateIdempotencyKey(method)
      : undefined;

    const { request, promise } = this.requests.createRequest(
      method,
      params,
      idempotencyKey
    );

    this.connection.send(JSON.stringify(request));

    const response = await promise;

    if (!response.ok) {
      throw new GatewayError(
        response.error?.code ?? "INTERNAL_ERROR",
        response.error?.message ?? "Unknown error",
        response.error?.details
      );
    }

    return response.payload as GatewayMethodResult[M];
  }

  ping(): Promise<GatewayMethodResult["ping"]> {
    return this.request("ping", {} as GatewayMethodParams["ping"]);
  }

  runtimeStatus(): Promise<GatewayMethodResult["runtime.status"]> {
    return this.request(
      "runtime.status",
      {} as GatewayMethodParams["runtime.status"]
    );
  }

  runtimeUpdateConfig(
    updates: GatewayMethodParams["runtime.updateConfig"]
  ): Promise<GatewayMethodResult["runtime.updateConfig"]> {
    return this.request(
      "runtime.updateConfig",
      updates
    );
  }

  sessionList(): Promise<GatewayMethodResult["session.list"]> {
    return this.request(
      "session.list",
      {} as GatewayMethodParams["session.list"]
    );
  }

  sessionGet(
    sessionId?: string
  ): Promise<GatewayMethodResult["session.get"]> {
    return this.request("session.get", { sessionId });
  }

  sessionCreate(
    name?: string
  ): Promise<GatewayMethodResult["session.create"]> {
    return this.request("session.create", { name });
  }

  sessionRename(
    name: string,
    sessionId?: string
  ): Promise<GatewayMethodResult["session.rename"]> {
    return this.request("session.rename", { name, sessionId });
  }

  sessionDelete(
    sessionId: string
  ): Promise<GatewayMethodResult["session.delete"]> {
    return this.request("session.delete", { sessionId });
  }

  sessionPurge(
    options: { keepRecent?: number; olderThanDays?: number } = {}
  ): Promise<GatewayMethodResult["session.purge"]> {
    return this.request("session.purge", options);
  }

  sessionUsage(
    sessionId: string
  ): Promise<GatewayMethodResult["session.usage"]> {
    return this.request("session.usage", { sessionId });
  }

  sessionBindProject(
    sessionId: string,
    projectDir: string
  ): Promise<GatewayMethodResult["session.bindProject"]> {
    return this.request("session.bindProject", { sessionId, projectDir });
  }

  sessionGetTranscript(
    sessionId: string
  ): Promise<GatewayMethodResult["session.getTranscript"]> {
    return this.request("session.getTranscript", { sessionId });
  }

  chatSend(
    sessionId: string,
    input: string
  ): Promise<GatewayMethodResult["chat.send"]> {
    this.resume.addActiveSession(sessionId);
    return this.request("chat.send", { sessionId, input });
  }

  chatCancel(
    runId: string
  ): Promise<GatewayMethodResult["chat.cancel"]> {
    return this.request("chat.cancel", { runId });
  }

  memorySearch(
    query: string
  ): Promise<GatewayMethodResult["memory.search"]> {
    return this.request("memory.search", { query });
  }

  memoryWrite(
    sessionId: string,
    content: string,
    scope?: "daily" | "long_term" | "auto"
  ): Promise<GatewayMethodResult["memory.write"]> {
    return this.request("memory.write", { sessionId, content, scope });
  }

  mcpStatus(): Promise<GatewayMethodResult["mcp.status"]> {
    return this.request("mcp.status", {} as GatewayMethodParams["mcp.status"]);
  }

  mcpTools(): Promise<GatewayMethodResult["mcp.tools"]> {
    return this.request("mcp.tools", {} as GatewayMethodParams["mcp.tools"]);
  }

  mcpConfigAdd(
    server: GatewayMethodParams["mcp.config.add"]["server"]
  ): Promise<GatewayMethodResult["mcp.config.add"]> {
    return this.request("mcp.config.add", { server });
  }

  skillsList(): Promise<GatewayMethodResult["skills.list"]> {
    return this.request(
      "skills.list",
      {} as GatewayMethodParams["skills.list"]
    );
  }

  skillsCurrent(
    sessionId: string
  ): Promise<GatewayMethodResult["skills.current"]> {
    return this.request("skills.current", { sessionId });
  }

  skillsUse(
    sessionId: string,
    skillName: string
  ): Promise<GatewayMethodResult["skills.use"]> {
    return this.request("skills.use", { sessionId, skillName });
  }

  skillsClear(
    sessionId: string
  ): Promise<GatewayMethodResult["skills.clear"]> {
    return this.request("skills.clear", { sessionId });
  }

  toolList(): Promise<GatewayMethodResult["tool.list"]> {
    return this.request("tool.list", {} as GatewayMethodParams["tool.list"]);
  }

  toolCall(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<GatewayMethodResult["tool.call"]> {
    return this.request("tool.call", { sessionId, toolName, input });
  }

  approvalList(
    sessionId: string
  ): Promise<GatewayMethodResult["approval.list"]> {
    return this.request("approval.list", { sessionId });
  }

  approvalConfirm(
    sessionId: string,
    token: string
  ): Promise<GatewayMethodResult["approval.confirm"]> {
    return this.request("approval.confirm", { sessionId, token });
  }

  approvalReject(
    sessionId: string,
    token: string
  ): Promise<GatewayMethodResult["approval.reject"]> {
    return this.request("approval.reject", { sessionId, token });
  }

  auditTail(options?: {
    limit?: number;
    type?: string;
    sessionId?: string;
    runId?: string;
    toolName?: string;
  }): Promise<GatewayMethodResult["audit.tail"]> {
    return this.request(
      "audit.tail",
      (options ?? {}) as GatewayMethodParams["audit.tail"]
    );
  }

  private setupInternalHandlers(): void {
    this.connection.onMessage((data) => {
      try {
        const parsed = JSON.parse(data);
        this.handleServerMessage(parsed);
      } catch {
        // ignore malformed messages
      }
    });

    this.connection.onClose(() => {
      this.requests.rejectAll(new ConnectionClosedError());
    });

    // Wire up resync: when server signals state.resync_required, trigger resync handlers
    this.events.onResyncRequired(() => {
      this.resume.triggerResync();
    });
  }

  private handleServerMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;

    const msg = message as Record<string, unknown>;

    if (msg.type === "res") {
      const response = msg as unknown as WsResponse;

      if (
        this.connection.state === "authenticating" &&
        response.id.startsWith("web_connect_")
      ) {
        this.connection.handleConnectResponse(
          response.ok,
          response.payload,
          response.error
        );

        if (response.ok && response.payload) {
          const payload = response.payload as Record<string, unknown>;
          if (payload.capabilities && typeof payload.capabilities === "object") {
            const caps = payload.capabilities as Record<string, boolean>;
            for (const [key, value] of Object.entries(caps)) {
              this.capabilities.set(key, value);
            }
          }
        }
      }

      this.requests.resolve(response.id, response);
      return;
    }

    if (msg.type === "event") {
      const event = msg as unknown as WsEvent;

      if (event.event === "heartbeat") {
        const payload = event.payload as { serverTime?: string } | undefined;
        if (payload?.serverTime) {
          this.connection.handleHeartbeat(payload.serverTime);
        }
        return;
      }

      this.events.dispatch(event);
      this.resume.trackEvent(event);
      return;
    }
  }
}
