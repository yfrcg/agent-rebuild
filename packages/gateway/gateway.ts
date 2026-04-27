import { ContextBuilder } from "./contextBuilder";
import type {
  GatewayDebugInfo,
  GatewayRequest,
  GatewayResponse,
  MemorySearchResult,
} from "./types";
import type { ChatMessage, ModelProvider, ModelResponse } from "../model/types";

type GatewayMemorySearch = (query: string) => Promise<MemorySearchResult[]>;
export type MemorySearch = GatewayMemorySearch;

export interface GatewayOptions {
  memorySearch: GatewayMemorySearch;
  modelProvider: ModelProvider;
  auditLogger?: unknown;
  debug?: boolean;
  rateLimiter?: unknown;
  circuitBreaker?: unknown;
  metricsCollector?: unknown;
  contextBuilder?: ContextBuilder;
}

interface RateLimitResult {
  allowed: boolean;
  remaining?: number;
  retryAfterMs?: number;
  reason?: string;
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
}

export class Gateway {
  private readonly memorySearch: GatewayMemorySearch;
  private readonly modelProvider: ModelProvider;
  private readonly auditLogger?: unknown;
  private readonly debug: boolean;
  private readonly rateLimiter?: unknown;
  private readonly circuitBreaker?: unknown;
  private readonly metricsCollector?: unknown;
  private readonly contextBuilder: ContextBuilder;

  constructor(options: GatewayOptions) {
    this.memorySearch = options.memorySearch;
    this.modelProvider = options.modelProvider;
    this.auditLogger = options.auditLogger;
    this.debug = options.debug ?? false;
    this.rateLimiter = options.rateLimiter;
    this.circuitBreaker = options.circuitBreaker;
    this.metricsCollector = options.metricsCollector;
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder();
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

    try {
      rateLimitInfo = await this.checkRateLimit();

      if (!rateLimitInfo.allowed) {
        responseText =
          "请求过于频繁，Gateway 已触发限流保护。请稍后再试。";

        const durationMs = Date.now() - startedAt;

        await this.recordMetrics({
          durationMs,
          success: false,
          errorMessage: rateLimitInfo.reason ?? "rate limited",
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
          errorMessage: rateLimitInfo.reason ?? "rate limited",
          rateLimited: true,
        });

        return this.createResponse({
          requestId,
          text: responseText,
          memoryUsed: [],
          memoryCount: 0,
          durationMs,
          hasError: true,
          errorMessage: rateLimitInfo.reason ?? "rate limited",
          rateLimit: rateLimitInfo,
        });
      }

      circuitInfo = this.getCircuitState();

      if (circuitInfo.open) {
        responseText =
          "上游模型暂时不可用，Gateway 熔断器已打开。请稍后再试。";

        const durationMs = Date.now() - startedAt;

        await this.recordMetrics({
          durationMs,
          success: false,
          errorMessage: circuitInfo.reason ?? "circuit breaker open",
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
          errorMessage: circuitInfo.reason ?? "circuit breaker open",
          circuitOpen: true,
        });

        return this.createResponse({
          requestId,
          text: responseText,
          memoryUsed: [],
          memoryCount: 0,
          durationMs,
          hasError: true,
          errorMessage: circuitInfo.reason ?? "circuit breaker open",
          rateLimit: rateLimitInfo,
          circuit: circuitInfo,
        });
      }

      try {
        memoryResults = await this.memorySearch(input);
      } catch (err) {
        hasError = true;
        errorMessage = this.toErrorMessage(err);
        memoryResults = [];
      }

      const messages = this.contextBuilder.buildMessages(input, memoryResults);

      try {
        responseText = await this.callModel(messages);
        this.recordCircuitSuccess();
      } catch (err) {
        hasError = true;
        errorMessage = this.toErrorMessage(err);
        responseText = "模型调用失败，Gateway 已捕获错误，没有让程序崩溃。";
        this.recordCircuitFailure(errorMessage);
      }

      const durationMs = Date.now() - startedAt;

      await this.recordMetrics({
        durationMs,
        success: !hasError,
        errorMessage,
      });

      await this.recordAudit({
        type: hasError
          ? "gateway.request.completed_with_error"
          : "gateway.request.completed",
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
        memoryCount: memoryResults.length,
        durationMs,
        hasError,
        errorMessage,
        rateLimit: rateLimitInfo,
        circuit: this.getCircuitState(),
      });
    } catch (err) {
      const fatalMessage = this.toErrorMessage(err);
      const durationMs = Date.now() - startedAt;
      const text = "Gateway 内部异常，已捕获错误，没有让程序崩溃。";

      await this.recordMetrics({
        durationMs,
        success: false,
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
        memoryCount: memoryResults.length,
        durationMs,
        hasError: true,
        errorMessage: fatalMessage,
        rateLimit: rateLimitInfo,
        circuit: circuitInfo,
      });
    }
  }

  private async callModel(messages: ChatMessage[]): Promise<string> {
    const provider = this.modelProvider as unknown as {
      generate?: (messages: ChatMessage[]) => Promise<string | ModelResponse>;
      chat?: (messages: ChatMessage[]) => Promise<string | ModelResponse>;
      complete?: (messages: ChatMessage[]) => Promise<string | ModelResponse>;
      invoke?: (messages: ChatMessage[]) => Promise<string | ModelResponse>;
    };

    if (typeof provider.generate === "function") {
      return this.extractModelText(await provider.generate(messages));
    }

    if (typeof provider.chat === "function") {
      return this.extractModelText(await provider.chat(messages));
    }

    if (typeof provider.complete === "function") {
      return this.extractModelText(await provider.complete(messages));
    }

    if (typeof provider.invoke === "function") {
      return this.extractModelText(await provider.invoke(messages));
    }

    throw new Error("ModelProvider does not expose a supported call method.");
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
        reason: open ? "circuit breaker open" : undefined,
      };
    }

    if (typeof breaker.canRequest === "function") {
      const canRequest = breaker.canRequest();
      return {
        open: !canRequest,
        state: canRequest ? "closed" : "open",
        reason: canRequest ? undefined : "circuit breaker open",
      };
    }

    if (typeof breaker.getState === "function") {
      const state = breaker.getState();
      return {
        open: state === "open",
        state,
        reason: state === "open" ? "circuit breaker open" : undefined,
      };
    }

    if (typeof breaker.state === "string") {
      return {
        open: breaker.state === "open",
        state: breaker.state,
        reason: breaker.state === "open" ? "circuit breaker open" : undefined,
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
    success: boolean;
    errorMessage?: string;
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

      if (typeof logger.log === "function") {
        await logger.log(event);
        return;
      }

      if (typeof logger.record === "function") {
        await logger.record(event);
        return;
      }

      if (typeof logger.append === "function") {
        await logger.append(event);
        return;
      }

      if (typeof logger.write === "function") {
        await logger.write(event);
      }
    } catch {
      // Audit is side-channel only.
      // It must never break the main Gateway request flow.
    }
  }

  private createResponse(input: {
    requestId: string;
    text: string;
    memoryUsed: MemorySearchResult[];
    memoryCount: number;
    durationMs: number;
    hasError: boolean;
    errorMessage?: string;
    rateLimit?: RateLimitResult;
    circuit?: CircuitState;
  }): GatewayResponse {
    const debugInfo: GatewayDebugInfo = {
      modelProvider: this.modelProvider.name,
      memoryCount: input.memoryCount,
      durationMs: input.durationMs,
      hasError: input.hasError,
      errorMessage: input.errorMessage,
      rateLimit: input.rateLimit,
      circuit: input.circuit,
      metrics: this.getMetricsSnapshot(),
    } as GatewayDebugInfo;

    return {
      id: input.requestId,
      text: input.text,
      memoryUsed: input.memoryUsed,
      error: input.errorMessage,
      debug: this.debug ? debugInfo : undefined,
      createdAt: new Date().toISOString(),
    } as GatewayResponse;
  }

  private extractModelText(result: string | ModelResponse): string {
    if (typeof result === "string") {
      return result;
    }

    if (result && typeof result.text === "string") {
      return result.text;
    }

    throw new Error("ModelProvider returned an unsupported response payload.");
  }

  private getMetricsSnapshot(): unknown {
    if (!this.metricsCollector) {
      return undefined;
    }

    const collector = this.metricsCollector as {
      snapshot?: () => unknown;
      getSnapshot?: () => unknown;
      toJSON?: () => unknown;
    };

    if (typeof collector.snapshot === "function") {
      return collector.snapshot();
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
