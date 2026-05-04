import { AgentRunner } from "./agentRunner";
import { ContextBuilder } from "./contextBuilder";
import type { BuiltGatewayContext } from "./contextBuilder";
import type { GatewaySandbox } from "./sandbox";
import type { ToolCallExecutor } from "./toolCallExecutor";
import type { GatewayToolCallRecord } from "./toolCallTypes";
import type { ToolRegistry } from "./toolRegistry";
import type {
  GatewayDebugInfo,
  GatewayRequest,
  GatewayResponse,
  MemorySearchResult,
} from "./types";
import type { ModelProvider } from "../model/types";

type GatewayMemorySearch = (query: string) => Promise<MemorySearchResult[]>;
export type MemorySearch = GatewayMemorySearch;

export interface GatewayOptions {
  memorySearch: GatewayMemorySearch;
  modelProvider: ModelProvider;
  toolRegistry?: ToolRegistry;
  toolCallExecutor?: ToolCallExecutor;
  auditLogger?: unknown;
  debug?: boolean;
  rateLimiter?: unknown;
  circuitBreaker?: unknown;
  metricsCollector?: unknown;
  contextBuilder?: ContextBuilder;
  sandbox?: GatewaySandbox;
  autoToolLoopEnabled?: boolean;
  autoToolLoopMaxSteps?: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining?: number;
  retryAfterMs?: number;
  reason?: string;
  limit?: number;
  windowMs?: number;
}

interface CircuitState {
  open: boolean;
  state?: string;
  reason?: string;
}

interface GatewayAuditEvent {
  type: string;
  timestamp: string;
  requestId: string;
  modelProvider: string;
  inputLength: number;
  responseLength: number;
  memoryCount: number;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  rateLimited?: boolean;
  circuitOpen?: boolean;
  metadata?: Record<string, unknown>;
}

export class Gateway {
  private readonly memorySearch: GatewayMemorySearch;
  private readonly modelProvider: ModelProvider;
  private readonly auditLogger?: unknown;
  private readonly debug: boolean;
  private readonly rateLimiter?: unknown;
  private readonly circuitBreaker?: unknown;
  private readonly metricsCollector?: unknown;
  private readonly sandbox?: GatewaySandbox;
  private readonly agentRunner: AgentRunner;

  constructor(options: GatewayOptions) {
    const contextBuilder = options.contextBuilder ?? new ContextBuilder();
    const autoToolLoopMaxSteps = options.autoToolLoopMaxSteps ?? 5;

    this.memorySearch = options.memorySearch;
    this.modelProvider = options.modelProvider;
    this.auditLogger = options.auditLogger;
    this.debug = options.debug ?? false;
    this.rateLimiter = options.rateLimiter;
    this.circuitBreaker = options.circuitBreaker;
    this.metricsCollector = options.metricsCollector;
    this.sandbox = options.sandbox;
    this.agentRunner = new AgentRunner({
      memorySearch: this.memorySearch,
      modelProvider: this.modelProvider,
      contextBuilder,
      toolRegistry: options.autoToolLoopEnabled === false ? undefined : options.toolRegistry,
      toolCallExecutor:
        options.autoToolLoopEnabled === false ? undefined : options.toolCallExecutor,
      auditLogger: this.auditLogger,
      maxToolCalls: autoToolLoopMaxSteps,
    });
  }

  async handle(request: GatewayRequest): Promise<GatewayResponse> {
    const startedAt = Date.now();
    const requestId = this.getRequestId(request);
    const input = this.getRequestInput(request);

    let memoryResults: MemorySearchResult[] = [];
    let responseText = "";
    let hasError = false;
    let errorMessage: string | undefined;
    let rateLimitInfo: RateLimitResult | undefined;
    let circuitInfo: CircuitState | undefined;
    let toolCalls: GatewayToolCallRecord[] = [];
    let autoToolLoopInfo: GatewayDebugInfo["autoToolLoop"];
    let builtContext: BuiltGatewayContext | undefined;

    try {
      await this.recordAudit({
        type: "gateway.request.received",
        timestamp: new Date().toISOString(),
        requestId,
        modelProvider: this.modelProvider.name,
        inputLength: input.length,
        responseLength: 0,
        memoryCount: 0,
        durationMs: 0,
        success: true,
      });

      rateLimitInfo = await this.checkRateLimit();
      if (!rateLimitInfo.allowed) {
        const durationMs = Date.now() - startedAt;
        responseText = "请求过于频繁，Gateway 已触发限流保护。请稍后再试。";

        await this.recordMetrics({
          durationMs,
          hasError: true,
          errorMessage: rateLimitInfo.reason ?? "Rate limit exceeded",
          rateLimited: true,
        });
        await this.recordAudit({
          type: "gateway.request.rate_limited",
          timestamp: new Date().toISOString(),
          requestId,
          modelProvider: this.modelProvider.name,
          inputLength: input.length,
          responseLength: responseText.length,
          memoryCount: 0,
          durationMs,
          success: false,
          errorMessage: rateLimitInfo.reason ?? "Rate limit exceeded",
          rateLimited: true,
        });

        return this.createResponse({
          requestId,
          text: responseText,
          memoryUsed: [],
          toolCalls: [],
          memoryCount: 0,
          durationMs,
          hasError: true,
          errorMessage: rateLimitInfo.reason ?? "Rate limit exceeded",
          rateLimit: rateLimitInfo,
          permissionMode: request.permissionMode,
          planState: request.planState,
        });
      }

      circuitInfo = this.getCircuitState();
      if (circuitInfo.open) {
        const durationMs = Date.now() - startedAt;
        responseText = "上游模型暂时不可用，Gateway 熔断器已打开。请稍后再试。";

        await this.recordMetrics({
          durationMs,
          hasError: true,
          errorMessage: circuitInfo.reason ?? "Circuit breaker is open",
          circuitOpen: true,
        });
        await this.recordAudit({
          type: "gateway.request.circuit_open",
          timestamp: new Date().toISOString(),
          requestId,
          modelProvider: this.modelProvider.name,
          inputLength: input.length,
          responseLength: responseText.length,
          memoryCount: 0,
          durationMs,
          success: false,
          errorMessage: circuitInfo.reason ?? "Circuit breaker is open",
          circuitOpen: true,
        });

        return this.createResponse({
          requestId,
          text: responseText,
          memoryUsed: [],
          toolCalls: [],
          memoryCount: 0,
          durationMs,
          hasError: true,
          errorMessage: circuitInfo.reason ?? "Circuit breaker is open",
          rateLimit: rateLimitInfo,
          circuit: circuitInfo,
          permissionMode: request.permissionMode,
          planState: request.planState,
        });
      }

      try {
        const result = await this.agentRunner.run(request);
        responseText = result.text;
        memoryResults = result.memoryResults;
        toolCalls = result.toolCalls;
        autoToolLoopInfo = result.autoToolLoop;
        builtContext = result.builtContext;
        this.recordCircuitSuccess();
      } catch (err) {
        hasError = true;
        errorMessage = this.toErrorMessage(err);
        responseText = "模型调用失败，Gateway 已捕获错误，没有让程序崩溃。";
        this.recordCircuitFailure(errorMessage);
      }

      await this.recordAudit({
        type: "memory.search.completed",
        timestamp: new Date().toISOString(),
        requestId,
        modelProvider: this.modelProvider.name,
        inputLength: input.length,
        responseLength: 0,
        memoryCount: memoryResults.length,
        durationMs: Date.now() - startedAt,
        success: !hasError,
        errorMessage,
      });

      await this.recordAudit({
        type: "context.built",
        timestamp: new Date().toISOString(),
        requestId,
        modelProvider: this.modelProvider.name,
        inputLength: input.length,
        responseLength: 0,
        memoryCount: memoryResults.length,
        durationMs: Date.now() - startedAt,
        success: !hasError,
        errorMessage,
      });

      await this.recordAudit({
        type: "model.generate.completed",
        timestamp: new Date().toISOString(),
        requestId,
        modelProvider: this.modelProvider.name,
        inputLength: input.length,
        responseLength: responseText.length,
        memoryCount: memoryResults.length,
        durationMs: Date.now() - startedAt,
        success: !hasError,
        errorMessage,
      });

      const durationMs = Date.now() - startedAt;
      await this.recordMetrics({
        durationMs,
        hasError,
        errorMessage,
      });
      await this.recordAudit({
        type: "gateway.response.completed",
        timestamp: new Date().toISOString(),
        requestId,
        modelProvider: this.modelProvider.name,
        inputLength: input.length,
        responseLength: responseText.length,
        memoryCount: memoryResults.length,
        durationMs,
        success: !hasError,
        errorMessage,
      });

      return this.createResponse({
        requestId,
        text: responseText,
        memoryUsed: memoryResults,
        toolCalls,
        memoryCount: memoryResults.length,
        durationMs,
        hasError,
        errorMessage,
        skillSelection: builtContext?.skillSelection,
        autoToolLoop: autoToolLoopInfo,
        rateLimit: rateLimitInfo,
        circuit: this.getCircuitState(),
        permissionMode: request.permissionMode,
        planState: request.planState,
      });
    } catch (err) {
      const fatalMessage = this.toErrorMessage(err);
      const durationMs = Date.now() - startedAt;
      const text = "Gateway 内部异常，已捕获错误，没有让程序崩溃。";

      await this.recordMetrics({
        durationMs,
        hasError: true,
        errorMessage: fatalMessage,
      });
      await this.recordAudit({
        type: "gateway.request.fatal_error",
        timestamp: new Date().toISOString(),
        requestId,
        modelProvider: this.modelProvider.name,
        inputLength: input.length,
        responseLength: text.length,
        memoryCount: memoryResults.length,
        durationMs,
        success: false,
        errorMessage: fatalMessage,
      });

      return this.createResponse({
        requestId,
        text,
        memoryUsed: memoryResults,
        toolCalls,
        memoryCount: memoryResults.length,
        durationMs,
        hasError: true,
        errorMessage: fatalMessage,
        skillSelection: builtContext?.skillSelection,
        autoToolLoop: autoToolLoopInfo,
        rateLimit: rateLimitInfo,
        circuit: circuitInfo,
        permissionMode: request.permissionMode,
        planState: request.planState,
      });
    }
  }

  private async checkRateLimit(): Promise<RateLimitResult> {
    if (!this.rateLimiter) {
      return { allowed: true };
    }

    const limiter = this.rateLimiter as {
      check?: () => RateLimitResult | Promise<RateLimitResult> | boolean;
      allow?: () => RateLimitResult | Promise<RateLimitResult> | boolean;
      consume?: () => RateLimitResult | Promise<RateLimitResult> | boolean;
    };

    const raw =
      typeof limiter.check === "function"
        ? await limiter.check()
        : typeof limiter.allow === "function"
          ? await limiter.allow()
          : typeof limiter.consume === "function"
            ? await limiter.consume()
            : { allowed: true };

    if (typeof raw === "boolean") {
      return { allowed: raw };
    }

    if (!raw) {
      return { allowed: true };
    }

    return {
      allowed:
        "allowed" in raw
          ? Boolean(raw.allowed)
          : "isAllowed" in raw
            ? Boolean((raw as { isAllowed: boolean }).isAllowed)
            : "limited" in raw
              ? !Boolean((raw as { limited: boolean }).limited)
              : true,
      remaining:
        "remaining" in raw && typeof raw.remaining === "number"
          ? raw.remaining
          : undefined,
      retryAfterMs:
        "retryAfterMs" in raw && typeof raw.retryAfterMs === "number"
          ? raw.retryAfterMs
          : undefined,
      reason:
        "reason" in raw && typeof raw.reason === "string"
          ? raw.reason
          : undefined,
      limit:
        "limit" in raw && typeof raw.limit === "number"
          ? raw.limit
          : undefined,
      windowMs:
        "windowMs" in raw && typeof raw.windowMs === "number"
          ? raw.windowMs
          : undefined,
    };
  }

  private getCircuitState(): CircuitState {
    if (!this.circuitBreaker) {
      return { open: false, state: "disabled" };
    }

    const breaker = this.circuitBreaker as {
      isOpen?: () => boolean;
      canRequest?: () => boolean;
      getState?: () => string;
      state?: string;
    };

    if (typeof breaker.isOpen === "function") {
      const open = breaker.isOpen();
      return {
        open,
        state: typeof breaker.getState === "function" ? breaker.getState() : undefined,
        reason: open ? "Circuit breaker is open" : undefined,
      };
    }

    if (typeof breaker.canRequest === "function") {
      const canRequest = breaker.canRequest();
      return {
        open: !canRequest,
        state: canRequest ? "closed" : "open",
        reason: canRequest ? undefined : "Circuit breaker is open",
      };
    }

    if (typeof breaker.getState === "function") {
      const state = breaker.getState();
      return {
        open: state === "open",
        state,
        reason: state === "open" ? "Circuit breaker is open" : undefined,
      };
    }

    if (typeof breaker.state === "string") {
      return {
        open: breaker.state === "open",
        state: breaker.state,
        reason: breaker.state === "open" ? "Circuit breaker is open" : undefined,
      };
    }

    return { open: false, state: "unknown" };
  }

  private recordCircuitSuccess(): void {
    if (!this.circuitBreaker) {
      return;
    }

    const breaker = this.circuitBreaker as {
      recordSuccess?: () => void;
      success?: () => void;
      onSuccess?: () => void;
    };

    if (typeof breaker.recordSuccess === "function") {
      breaker.recordSuccess();
      return;
    }
    if (typeof breaker.success === "function") {
      breaker.success();
      return;
    }
    if (typeof breaker.onSuccess === "function") {
      breaker.onSuccess();
    }
  }

  private recordCircuitFailure(errorMessage?: string): void {
    if (!this.circuitBreaker) {
      return;
    }

    const breaker = this.circuitBreaker as {
      recordFailure?: (errorMessage?: string) => void;
      failure?: (errorMessage?: string) => void;
      onFailure?: (errorMessage?: string) => void;
    };

    if (typeof breaker.recordFailure === "function") {
      breaker.recordFailure(errorMessage);
      return;
    }
    if (typeof breaker.failure === "function") {
      breaker.failure(errorMessage);
      return;
    }
    if (typeof breaker.onFailure === "function") {
      breaker.onFailure(errorMessage);
    }
  }

  private async recordMetrics(input: {
    durationMs: number;
    hasError: boolean;
    errorMessage?: string;
    rateLimited?: boolean;
    circuitOpen?: boolean;
  }): Promise<void> {
    if (!this.metricsCollector) {
      return;
    }

    const collector = this.metricsCollector as {
      record?: (input: unknown) => void | Promise<void>;
      observe?: (input: unknown) => void | Promise<void>;
      collect?: (input: unknown) => void | Promise<void>;
    };

    if (typeof collector.record === "function") {
      await collector.record(input);
      return;
    }
    if (typeof collector.observe === "function") {
      await collector.observe(input);
      return;
    }
    if (typeof collector.collect === "function") {
      await collector.collect(input);
    }
  }

  private async recordAudit(event: GatewayAuditEvent): Promise<void> {
    if (!this.auditLogger) {
      return;
    }

    try {
      const logger = this.auditLogger as {
        log?: (event: unknown) => void | Promise<void>;
        record?: (event: unknown) => void | Promise<void>;
        append?: (event: unknown) => void | Promise<void>;
        write?: (event: unknown) => void | Promise<void>;
      };
      const normalizedEvent = {
        id: `${event.requestId}-${Date.now()}`,
        requestId: event.requestId,
        type: event.type,
        message: event.errorMessage ?? event.type,
        createdAt: event.timestamp,
        data: {
          modelProvider: event.modelProvider,
          inputLength: event.inputLength,
          responseLength: event.responseLength,
          memoryCount: event.memoryCount,
          durationMs: event.durationMs,
          success: event.success,
          errorMessage: event.errorMessage,
          rateLimited: event.rateLimited,
          circuitOpen: event.circuitOpen,
          ...(event.metadata ?? {}),
        },
      };

      if (typeof logger.log === "function") {
        await logger.log(normalizedEvent);
        return;
      }
      if (typeof logger.record === "function") {
        await logger.record(normalizedEvent);
        return;
      }
      if (typeof logger.append === "function") {
        await logger.append(normalizedEvent);
        return;
      }
      if (typeof logger.write === "function") {
        await logger.write(normalizedEvent);
      }
    } catch {
      // audit failures must not break the request path
    }
  }

  private createResponse(input: {
    requestId: string;
    text: string;
    memoryUsed: MemorySearchResult[];
    toolCalls: GatewayToolCallRecord[];
    memoryCount: number;
    durationMs: number;
    hasError: boolean;
    errorMessage?: string;
    skillSelection?: GatewayDebugInfo["skillSelection"];
    autoToolLoop?: GatewayDebugInfo["autoToolLoop"];
    rateLimit?: RateLimitResult;
    circuit?: CircuitState;
    permissionMode?: GatewayRequest["permissionMode"];
    planState?: GatewayRequest["planState"];
  }): GatewayResponse {
    const debugInfo: GatewayDebugInfo = {
      modelProvider: this.modelProvider.name,
      memoryCount: input.memoryCount,
      durationMs: input.durationMs,
      hasError: input.hasError,
      errorMessage: input.errorMessage,
      autoToolLoop: input.autoToolLoop,
      memorySelection: {
        hitCount: input.memoryUsed.length,
        sourceBreakdown: summarizeMemorySources(input.memoryUsed),
        topMemoryIds: input.memoryUsed.slice(0, 3).map((item) => item.id),
        hasRecentMemory: input.memoryUsed.some((item) => isRecentMemoryResult(item)),
      },
      skillSelection: input.skillSelection,
      permission: {
        mode: input.permissionMode ?? "default",
      },
      plan: input.planState,
      rateLimit: input.rateLimit
        ? {
            allowed: input.rateLimit.allowed,
            remaining: input.rateLimit.remaining ?? 0,
            retryAfterMs: input.rateLimit.retryAfterMs ?? 0,
            limit: input.rateLimit.limit ?? 0,
            windowMs: input.rateLimit.windowMs ?? 0,
          }
        : undefined,
      circuit: input.circuit,
      sandbox: this.sandbox
        ? {
            mode: this.sandbox.mode,
            allowedRoots: this.sandbox.allowedRoots,
            backend: "local",
            enabled: true,
            containerMode: "local-windows",
          }
        : undefined,
      metrics: this.getMetricsSnapshot() as GatewayDebugInfo["metrics"],
    };

    return {
      id: input.requestId,
      text: input.text,
      memoryUsed: input.memoryUsed,
      toolCalls: input.toolCalls,
      error: input.errorMessage,
      debug: this.debug ? debugInfo : undefined,
      createdAt: new Date().toISOString(),
    };
  }

  private getMetricsSnapshot(): unknown {
    if (!this.metricsCollector) {
      return undefined;
    }

    const rawState = this.getCircuitState().state;
    const circuitState =
      rawState === "open" || rawState === "half-open" ? rawState : "closed";

    const collector = this.metricsCollector as {
      snapshot?: (circuitState?: string) => unknown;
      getSnapshot?: () => unknown;
      toJSON?: () => unknown;
    };

    if (typeof collector.snapshot === "function") {
      return collector.snapshot(circuitState);
    }
    if (typeof collector.getSnapshot === "function") {
      return collector.getSnapshot();
    }
    if (typeof collector.toJSON === "function") {
      return collector.toJSON();
    }

    return undefined;
  }

  private getRequestId(request: GatewayRequest): string {
    const value = request as unknown as {
      id?: string;
      requestId?: string;
    };

    return value.requestId ?? value.id ?? `gateway-${Date.now()}`;
  }

  private getRequestInput(request: GatewayRequest): string {
    const value = request as unknown as {
      input?: string;
      text?: string;
      query?: string;
      content?: string;
    };

    return value.input ?? value.text ?? value.query ?? value.content ?? "";
  }

  private toErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    if (typeof err === "string") {
      return err;
    }

    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  }
}

function summarizeMemorySources(memoryUsed: MemorySearchResult[]): Record<string, number> {
  return memoryUsed.reduce<Record<string, number>>((acc, item) => {
    const sourceKind =
      typeof item.metadata?.sourceKind === "string"
        ? item.metadata.sourceKind
        : item.source ?? "unknown";
    acc[sourceKind] = (acc[sourceKind] ?? 0) + 1;
    return acc;
  }, {});
}

function isRecentMemoryResult(item: MemorySearchResult): boolean {
  const directDate = item.metadata?.date;
  if (typeof directDate === "string") {
    return isRecentMemoryDate(directDate);
  }

  const filePath =
    typeof item.metadata?.filePath === "string"
      ? item.metadata.filePath
      : typeof item.source === "string"
        ? item.source
        : undefined;
  const inferredDate = filePath ? extractDateFromMemoryPath(filePath) : undefined;
  return typeof inferredDate === "string" && isRecentMemoryDate(inferredDate);
}

function extractDateFromMemoryPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/memory\/(\d{4}-\d{2}-\d{2})\.md$/);
  return match?.[1];
}

function isRecentMemoryDate(date: string): boolean {
  const timestamp = Date.parse(`${date}T00:00:00+08:00`);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  return Date.now() - timestamp <= 7 * 86_400_000;
}
