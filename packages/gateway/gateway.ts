import {
  buildAutoToolAnswerMessages,
  buildAutoToolDecisionMessages,
  mergeMemoryResults,
  normalizeMemorySearchResults,
  parseAutoToolDecision,
} from "./autoToolLoop";
import { ContextBuilder } from "./contextBuilder";
import type { BuiltGatewayContext } from "./contextBuilder";
import { createGatewayToolCallRequest } from "./toolCallFactory";
import type { GatewaySandbox } from "./sandbox";
import type { ToolCallExecutor } from "./toolCallExecutor";
import type { GatewayToolCallRecord } from "./toolCallTypes";
import type { GatewayToolListItem } from "./toolTypes";
import type { ToolRegistry } from "./toolRegistry";
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
  private readonly toolRegistry?: ToolRegistry;
  private readonly toolCallExecutor?: ToolCallExecutor;
  private readonly auditLogger?: unknown;
  private readonly debug: boolean;
  private readonly rateLimiter?: unknown;
  private readonly circuitBreaker?: unknown;
  private readonly metricsCollector?: unknown;
  private readonly contextBuilder: ContextBuilder;
  private readonly sandbox?: GatewaySandbox;
  private readonly autoToolLoopEnabled: boolean;
  private readonly autoToolLoopMaxSteps: number;

  constructor(options: GatewayOptions) {
    this.memorySearch = options.memorySearch;
    this.modelProvider = options.modelProvider;
    this.toolRegistry = options.toolRegistry;
    this.toolCallExecutor = options.toolCallExecutor;
    this.auditLogger = options.auditLogger;
    this.debug = options.debug ?? false;
    this.rateLimiter = options.rateLimiter;
    this.circuitBreaker = options.circuitBreaker;
    this.metricsCollector = options.metricsCollector;
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder();
    this.sandbox = options.sandbox;
    this.autoToolLoopEnabled = options.autoToolLoopEnabled ?? true;
    this.autoToolLoopMaxSteps = options.autoToolLoopMaxSteps ?? 3;
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
        responseText = "请求过于频繁，Gateway 已触发限流保护。请稍后再试。";

        const durationMs = Date.now() - startedAt;

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

        await this.recordAudit({
          type: "gateway.rate_limited",
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
        });
      }

      circuitInfo = this.getCircuitState();

      if (circuitInfo.open) {
        responseText = "上游模型暂时不可用，Gateway 熔断器已打开。请稍后再试。";

        const durationMs = Date.now() - startedAt;

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

        await this.recordAudit({
          type: "gateway.circuit.open",
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
        });
      }

      try {
        memoryResults = await this.memorySearch(input);
      } catch (err) {
        hasError = true;
        errorMessage = this.toErrorMessage(err);
        memoryResults = [];
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

      builtContext = this.contextBuilder.buildContext(input, memoryResults, {
        activeSkillNames: request.activeSkills,
      });
      const messages = builtContext.messages;

      await this.recordAudit({
        type: "context.built",
        timestamp: new Date().toISOString(),
        requestId,
        modelProvider: this.modelProvider.name,
        inputLength: input.length,
        responseLength: 0,
        memoryCount: memoryResults.length,
        durationMs: Date.now() - startedAt,
        success: true,
      });

      try {
        const toolLoopResult = await this.respondWithOptionalTools({
          request,
          requestId,
          baseMessages: messages,
          memoryResults,
        });

        responseText = toolLoopResult.text;
        memoryResults = toolLoopResult.memoryResults;
        toolCalls = toolLoopResult.toolCalls;
        autoToolLoopInfo = toolLoopResult.autoToolLoop;
        this.recordCircuitSuccess();
      } catch (err) {
        hasError = true;
        errorMessage = this.toErrorMessage(err);
        responseText = "模型调用失败，Gateway 已捕获错误，没有让程序崩溃。";
        this.recordCircuitFailure(errorMessage);
      }

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
        skillSelection: builtContext.skillSelection,
        autoToolLoop: autoToolLoopInfo,
        rateLimit: rateLimitInfo,
        circuit: this.getCircuitState(),
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

  private async respondWithOptionalTools(input: {
    request: GatewayRequest;
    requestId: string;
    baseMessages: ChatMessage[];
    memoryResults: MemorySearchResult[];
  }): Promise<{
    text: string;
    memoryResults: MemorySearchResult[];
    toolCalls: GatewayToolCallRecord[];
    autoToolLoop: GatewayDebugInfo["autoToolLoop"];
  }> {
    const availableTools = this.getAutoRunnableTools();
    const decisionTrace: NonNullable<
      GatewayDebugInfo["autoToolLoop"]
    >["decisionTrace"] = [];

    if (
      !this.autoToolLoopEnabled ||
      !this.toolRegistry ||
      !this.toolCallExecutor ||
      availableTools.length === 0
    ) {
      return {
        text: await this.callModel(input.baseMessages),
        memoryResults: input.memoryResults,
        toolCalls: [],
        autoToolLoop: {
          enabled: this.autoToolLoopEnabled,
          attempted: false,
          toolCallCount: 0,
          maxSteps: this.autoToolLoopMaxSteps,
          availableTools: availableTools.map((tool) => ({
            name: tool.name,
            automationLevel: tool.policy?.automationLevel,
            riskLevel: tool.policy?.riskLevel,
          })),
          decisionTrace,
          finishReason: availableTools.length === 0 ? "no-tools-available" : "disabled",
        },
      };
    }

    const toolCalls: GatewayToolCallRecord[] = [];
    let augmentedMemory = [...input.memoryResults];
    let plannerError: string | undefined;
    let finishReason = "respond";

    for (let step = 0; step < this.autoToolLoopMaxSteps; step += 1) {
      const decisionMessages = buildAutoToolDecisionMessages({
        baseMessages: input.baseMessages,
        tools: availableTools,
        toolCalls,
        maxSteps: this.autoToolLoopMaxSteps,
      });

      const rawDecision = await this.callModel(decisionMessages);

      try {
        const decision = parseAutoToolDecision(rawDecision);

        await this.recordAudit({
          type: "gateway.auto_tool.decision",
          timestamp: new Date().toISOString(),
          requestId: input.requestId,
          modelProvider: this.modelProvider.name,
          inputLength: input.request.input.length,
          responseLength: rawDecision.length,
          memoryCount: augmentedMemory.length,
          durationMs: 0,
          success: true,
          metadata: {
            step: step + 1,
            action: decision.action,
            toolName: decision.action === "tool" ? decision.toolName : undefined,
            reason: decision.reason,
          },
        });

        if (decision.action === "respond") {
          finishReason = toolCalls.length > 0 ? "tool-augmented-respond" : "respond";
          decisionTrace.push({
            step: step + 1,
            action: "respond",
            reason: decision.reason,
            status: "completed",
          });

          const answerMessages = buildAutoToolAnswerMessages({
            baseMessages: input.baseMessages,
            toolCalls,
          });

          return {
            text: await this.callModel(answerMessages),
            memoryResults: augmentedMemory,
            toolCalls,
            autoToolLoop: {
              enabled: true,
              attempted: true,
              toolCallCount: toolCalls.length,
              maxSteps: this.autoToolLoopMaxSteps,
              availableTools: availableTools.map((tool) => ({
                name: tool.name,
                automationLevel: tool.policy?.automationLevel,
                riskLevel: tool.policy?.riskLevel,
              })),
              decisionTrace,
              finishReason,
            },
          };
        }

        if (!availableTools.some((tool) => tool.name === decision.toolName)) {
          plannerError = `[auto-tool] planner selected unavailable tool: ${decision.toolName}`;
          finishReason = "planner-invalid-tool";
          decisionTrace.push({
            step: step + 1,
            action: "error",
            toolName: decision.toolName,
            reason: decision.reason,
            error: plannerError,
          });
          break;
        }

        const toolCallRequest = createGatewayToolCallRequest({
          toolName: decision.toolName,
          input: decision.input,
          sessionId: input.request.sessionId,
          requestId: input.requestId,
        });
        const toolCallRecord = await this.toolCallExecutor.execute(toolCallRequest);
        toolCalls.push(toolCallRecord);
        decisionTrace.push({
          step: step + 1,
          action: "tool",
          toolName: decision.toolName,
          reason: decision.reason,
          status: toolCallRecord.status,
          error: toolCallRecord.error,
        });

        if (toolCallRecord.toolName === "memory.search" && toolCallRecord.output?.ok) {
          const extraMemory = normalizeMemorySearchResults(toolCallRecord.output.content);
          augmentedMemory = mergeMemoryResults(augmentedMemory, extraMemory);
        }

        finishReason = toolCallRecord.output?.ok ? "tool-called" : "tool-call-failed";
      } catch (err) {
        plannerError = this.toErrorMessage(err);
        finishReason = "planner-parse-failed";

        await this.recordAudit({
          type: "gateway.auto_tool.decision",
          timestamp: new Date().toISOString(),
          requestId: input.requestId,
          modelProvider: this.modelProvider.name,
          inputLength: input.request.input.length,
          responseLength: rawDecision.length,
          memoryCount: augmentedMemory.length,
          durationMs: 0,
          success: false,
          errorMessage: plannerError,
          metadata: {
            step: step + 1,
            action: "error",
            error: plannerError,
          },
        });
        decisionTrace.push({
          step: step + 1,
          action: "error",
          error: plannerError,
        });
        break;
      }
    }

    const answerMessages = buildAutoToolAnswerMessages({
      baseMessages: input.baseMessages,
      toolCalls,
    });

    return {
      text: await this.callModel(answerMessages),
      memoryResults: augmentedMemory,
      toolCalls,
      autoToolLoop: {
        enabled: true,
        attempted: true,
        toolCallCount: toolCalls.length,
        maxSteps: this.autoToolLoopMaxSteps,
        availableTools: availableTools.map((tool) => ({
          name: tool.name,
          automationLevel: tool.policy?.automationLevel,
          riskLevel: tool.policy?.riskLevel,
        })),
        decisionTrace,
        finishReason: finishReason === "tool-called" ? "tool-budget-exhausted" : finishReason,
        plannerError,
      },
    };
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
      // 审计是旁路能力，绝不能反向打断主请求。
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
            backend: this.sandbox.containerConfig.backend,
            enabled: this.sandbox.containerConfig.enabled,
            containerMode: this.sandbox.containerConfig.mode,
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

  private getAutoRunnableTools(): GatewayToolListItem[] {
    if (!this.toolRegistry) {
      return [];
    }

    return this.toolRegistry
      .list()
      .filter(
        (tool) =>
          (tool.name === "memory.search" || tool.name.startsWith("mcp.")) &&
          (tool.policy?.automationLevel ?? "manual") === "auto"
      );
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
