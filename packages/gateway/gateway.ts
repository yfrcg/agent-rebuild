
import { AgentRunner } from "./agentRunner";
import { ContextBuilder } from "./contextBuilder";
import type { BuiltGatewayContext } from "./contextBuilder";
import { ContextCompressor } from "./contextCompressor";
import type { GatewaySandbox } from "./sandbox";
import type { SessionManager } from "./sessionManager";
import { SessionMemoryManager } from "./sessionMemoryManager";
import type { ToolCallExecutor } from "./toolCallExecutor";
import type { GatewayToolCallRecord } from "./toolCallTypes";
import type { GatewayProjectBoundary } from "./toolCallTypes";
import type { ToolRegistry } from "./toolRegistry";
import type { GatewayMcpManager } from "./mcpManager";
import type {
  GatewayDebugInfo,
  GatewayHandleOptions,
  GatewayRequest,
  GatewayResponse,
  MemorySearchResult,
} from "./types";
import type { ModelProvider } from "../model/types";
import { extractProjectBoundary } from "./sessionTypes";
import { MemoryAutoWriter } from "./memoryAutoWriter";
import type { MemoryAutoWriterConfig } from "./memoryAutoWriter";
import { ReviewGraphRunner } from "./reviewGraph/graphRunner";
import {
  extractStructuredJsonRanges,
  extractMeaningfulContent,
  tryParseStructuredPayload,
} from "./textSanitizer";
import type { ReviewGraphRunOutput } from "./reviewGraph/graphRunner";
import type { ReviewGraphRunnerOptions } from "./reviewGraph/types";
import { formatReportAsText } from "./reviewGraph/reportBuilder";

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
  devTaskMaxSteps?: number;
  devTaskMaxFixRounds?: number;
  sessionTokenBudget?: number;
  sessionCostBudgetCents?: number;
  sessionManager?: SessionManager;
  memoryAutoWriterConfig?: Partial<MemoryAutoWriterConfig>;
  mcpManager?: GatewayMcpManager;
  autoReviewGraphEnabled?: boolean;
  reviewGraphOptions?: ReviewGraphRunnerOptions;
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
  private readonly sessionManager?: SessionManager;
  private readonly memoryAutoWriter: MemoryAutoWriter;
  private readonly mcpManager?: GatewayMcpManager;
  private readonly toolRegistry?: ToolRegistry;
  private readonly reviewGraphRunner?: ReviewGraphRunner;
  public autoReviewGraphEnabled: boolean;
  private mcpInitialized = false;

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(options: GatewayOptions) {
    const contextBuilder = options.contextBuilder ?? new ContextBuilder();
    const autoToolLoopMaxSteps = options.autoToolLoopMaxSteps ?? 15;

    this.memorySearch = options.memorySearch;
    this.modelProvider = options.modelProvider;
    this.auditLogger = options.auditLogger;
    this.debug = options.debug ?? false;
    this.rateLimiter = options.rateLimiter;
    this.circuitBreaker = options.circuitBreaker;
    this.metricsCollector = options.metricsCollector;
    this.sandbox = options.sandbox;
    this.sessionManager = options.sessionManager;
    this.mcpManager = options.mcpManager;
    this.toolRegistry = options.toolRegistry;
    this.autoReviewGraphEnabled = options.autoReviewGraphEnabled ?? false;

    this.memoryAutoWriter = new MemoryAutoWriter({
      modelProvider: this.modelProvider,
      ...options.memoryAutoWriterConfig,
    });

    this.agentRunner = new AgentRunner({
      memorySearch: this.memorySearch,
      modelProvider: this.modelProvider,
      contextBuilder,
      toolRegistry: options.toolRegistry,
      toolCallExecutor: options.toolCallExecutor,
      auditLogger: this.auditLogger,
      maxToolCalls: autoToolLoopMaxSteps,
      devTaskMaxSteps: options.devTaskMaxSteps,
      devTaskMaxFixRounds: options.devTaskMaxFixRounds,
      sessionTokenBudget: options.sessionTokenBudget,
      sessionCostBudgetCents: options.sessionCostBudgetCents,
    });

    if (options.toolRegistry && options.toolCallExecutor) {
      this.reviewGraphRunner = new ReviewGraphRunner({
        modelProvider: this.modelProvider,
        toolRegistry: options.toolRegistry,
        toolCallExecutor: options.toolCallExecutor,
        workspaceRoot: process.cwd(),
        auditLogger: this.auditLogger as ReviewGraphRunner["auditLogger"],
        ...options.reviewGraphOptions,
      });
    }
  }

  /**
   * 方法 `handle` 的职责说明。
   * `handle` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  async handle(
    request: GatewayRequest,
    options: GatewayHandleOptions = {}
  ): Promise<GatewayResponse> {
    await this.ensureMcpInitialized();
    throwIfAborted(options.signal);
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
    let devTaskInfo: GatewayDebugInfo["devTask"];
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
        const requestWithBoundary: GatewayRequest = {
          ...request,
          projectBoundary: this.resolveProjectBoundary(request.sessionId),
        };

        if (this.reviewGraphRunner && this.autoReviewGraphEnabled && this.shouldUseReviewGraph(input)) {
          const reviewResult = await this.reviewGraphRunner.run({
            userGoal: input,
            taskType: undefined,
            targetFiles: [],
            constraints: [],
          });

          responseText = this.formatReviewGraphResponse(reviewResult);
          memoryResults = [];
          toolCalls = [];
          autoToolLoopInfo = undefined;
          devTaskInfo = undefined;
          builtContext = undefined;
          this.recordCircuitSuccess();
        } else {
          const result = await this.agentRunner.run(requestWithBoundary, {
            signal: options.signal,
            onEvent: options.onEvent,
          });
          throwIfAborted(options.signal);
          responseText = result.plainTextFallback
            ? buildPlainTextFallbackResponse(result.text, result.toolCalls)
            : result.text;
          memoryResults = result.memoryResults;
          toolCalls = result.toolCalls;
          autoToolLoopInfo = result.autoToolLoop;
          devTaskInfo = result.devTask;
          builtContext = result.builtContext;
          this.recordCircuitSuccess();
        }
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        hasError = true;
        errorMessage = this.toErrorMessage(err);
        responseText = "模型调用失败，Gateway 已捕获错误，没有让程序崩溃。";
        console.error("[GATEWAY_ERROR] errorMessage:", errorMessage);
        console.error("[GATEWAY_ERROR] stack:", err instanceof Error ? err.stack : "no stack");
        this.recordCircuitFailure(errorMessage);
        try {
          const fs = require("node:fs");
          fs.mkdirSync("logs", { recursive: true });
          fs.appendFileSync("logs/model-debug.log", `[GATEWAY_ERROR] ${errorMessage}\n${err instanceof Error ? err.stack : "no stack"}\n`);
        } catch (logErr) {
          console.error("[GATEWAY_ERROR] failed to write log file:", logErr);
        }
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
        toolCallCount: toolCalls.length,
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

      if (this.sessionManager && devTaskInfo?.active) {
        try {
          const testCommands = (devTaskInfo.testResults ?? []).map((r) => r.command);
          const lastFailure = (devTaskInfo.testResults ?? [])
            .filter((r) => !r.passed)
            .slice(-1)[0];
          this.sessionManager.setCurrentSessionDevTaskState({
            isDevTask: true,
            startedAt: new Date(startedAt).toISOString(),
            updatedAt: new Date().toISOString(),
            filesTouched: devTaskInfo.filesModified ?? [],
            commandsRun: devTaskInfo.commandsRun ?? 0,
            testCommands,
            lastFailureSummary: lastFailure?.summary,
            finalSummary: devTaskInfo.finalSummary,
            fixRounds: devTaskInfo.fixRounds ?? 0,
            status: devTaskInfo.status ?? "running",
          });
        } catch {
          // session persistence is best-effort
        }
      }

      if (this.sessionManager && !hasError) {
        try {
          const sessionId = request.sessionId ?? this.sessionManager.getCurrentSessionId();
          const smm = new SessionMemoryManager(sessionId);

          const allMessages = builtContext?.messages ?? [];
          const patch = ContextCompressor.extractSessionMemoryPatch(allMessages);
          patch.goal = input.slice(0, 200);
          if (devTaskInfo?.finalSummary) {
            patch.failures = [...(patch.failures ?? []), devTaskInfo.finalSummary.slice(0, 200)];
          }
          smm.applyPatch(patch);

          const currentSummary = smm.readRollingSummary();
          const turnSummary = [
            currentSummary,
            "",
            `## Turn ${new Date().toISOString().slice(0, 16)}`,
            `- User: ${input.slice(0, 150).replace(/\n/g, " ")}`,
            `- Response: ${responseText.slice(0, 150).replace(/\n/g, " ")}`,
            patch.filesTouched?.length ? `- Files: ${patch.filesTouched.join(", ")}` : "",
            patch.failures?.length ? `- Failures: ${patch.failures.join("; ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");

          const trimmedSummary = turnSummary.length > 4000
            ? turnSummary.slice(turnSummary.length - 4000)
            : turnSummary;
          smm.writeRollingSummary(trimmedSummary);

          if (!hasError && input.trim().length > 0) {
            this.memoryAutoWriter.evaluateAndWrite(
              input,
              responseText,
              toolCalls,
              patch
            );
          }
        } catch {
          // session memory update is best-effort
        }
      }

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
        devTask: devTaskInfo,
        rateLimit: rateLimitInfo,
        circuit: this.getCircuitState(),
        permissionMode: request.permissionMode,
        planState: request.planState,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      const fatalMessage = this.toErrorMessage(err);
      const durationMs = Date.now() - startedAt;
      const text = "Gateway 内部异常，已捕获错误，没有让程序崩溃。";
      console.error("[GATEWAY_FATAL] errorMessage:", fatalMessage);
      console.error("[GATEWAY_FATAL] stack:", err instanceof Error ? err.stack : "no stack");

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
        devTask: devTaskInfo,
        rateLimit: rateLimitInfo,
        circuit: circuitInfo,
        permissionMode: request.permissionMode,
        planState: request.planState,
      });
    }
  }

  /**
   * 方法 `ensureMcpInitialized` 的职责说明。
   * `ensureMcpInitialized` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private async ensureMcpInitialized(): Promise<void> {
    if (this.mcpInitialized || !this.mcpManager) {
      return;
    }
    this.mcpInitialized = true;
    try {
      await this.mcpManager.connectEnabledServers();
      if (this.toolRegistry) {
        await this.mcpManager.registerTools(this.toolRegistry);
      }
    } catch {
      // MCP init failure is non-fatal
    }
  }

  /**
   * 方法 `checkRateLimit` 的职责说明。
   * `checkRateLimit` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  /**
   * 方法 `getCircuitState` 的职责说明。
   * `getCircuitState` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  /**
   * 方法 `recordCircuitSuccess` 的职责说明。
   * `recordCircuitSuccess` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  /**
   * 方法 `recordCircuitFailure` 的职责说明。
   * `recordCircuitFailure` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  /**
   * 方法 `recordMetrics` 的职责说明。
   * `recordMetrics` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private async recordMetrics(input: {
    durationMs: number;
    hasError: boolean;
    errorMessage?: string;
    rateLimited?: boolean;
    circuitOpen?: boolean;
    toolCallCount?: number;
    toolRetryCount?: number;
  }): Promise<void> {
    if (!this.metricsCollector) {
      return;
    }

    try {
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
    } catch {
      // metrics recording should never crash the request handler
    }
  }

  /**
   * 方法 `recordAudit` 的职责说明。
   * `recordAudit` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  /**
   * 方法 `createResponse` 的职责说明。
   * `createResponse` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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
    devTask?: GatewayDebugInfo["devTask"];
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
      devTask: input.devTask,
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

  /**
   * 方法 `getMetricsSnapshot` 的职责说明。
   * `getMetricsSnapshot` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  /**
   * 方法 `getRequestId` 的职责说明。
   * `getRequestId` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private getRequestId(request: GatewayRequest): string {
    const value = request as unknown as {
      id?: string;
      requestId?: string;
    };

    return value.requestId ?? value.id ?? `gateway-${Date.now()}`;
  }

  /**
   * 方法 `getRequestInput` 的职责说明。
   * `getRequestInput` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private getRequestInput(request: GatewayRequest): string {
    const value = request as unknown as {
      input?: string;
      text?: string;
      query?: string;
      content?: string;
    };

    return value.input ?? value.text ?? value.query ?? value.content ?? "";
  }

  /**
   * 方法 `toErrorMessage` 的职责说明。
   * `toErrorMessage` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  /**
   * 方法 `resolveProjectBoundary` 的职责说明。
   * `resolveProjectBoundary` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private resolveProjectBoundary(
    sessionId: string | undefined
  ): GatewayProjectBoundary | undefined {
    if (!this.sessionManager || !sessionId) {
      return undefined;
    }

    try {
      const session = this.sessionManager.listSessions().find((s) => s.id === sessionId);
      if (!session) {
        return undefined;
      }
      return extractProjectBoundary(session);
    } catch {
      return undefined;
    }
  }

  /**
   * 方法 `shouldUseReviewGraph` 的职责说明。
   * `shouldUseReviewGraph` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private shouldUseReviewGraph(input: string): boolean {
    const trimmed = input.trim();
    if (trimmed.length < 10) {
      return false;
    }

    const devKeywords = [
      /\bfix\b/i,
      /\bbug\b/i,
      /\bfeature\b/i,
      /\badd\b/i,
      /\bimplement\b/i,
      /\brefactor\b/i,
      /\boptimize\b/i,
      /\bcreate\b/i,
      /\bupdate\b/i,
      /\bmodify\b/i,
      /\bchange\b/i,
      /\bdelete\b/i,
      /\bremove\b/i,
      /\bwrite\b/i,
      /\btest\b/i,
      /\bdebug\b/i,
      /修复/,
      /新增/,
      /实现/,
      /重构/,
      /优化/,
      /创建/,
      /制作/,
      /修改/,
      /删除/,
      /测试/,
      /调试/,
      /编写/,
      /生成/,
    ];

    const hasDevKeyword = devKeywords.some((pattern) => pattern.test(trimmed));
    if (!hasDevKeyword) {
      return false;
    }

    const casualPatterns = [
      /^(hi|hello|hey|你好|嗨)\b/i,
      /^(thanks|thank you|谢谢)/i,
      /^(what is|what are|什么是|怎么)/i,
      /^(how are you|你好吗)/i,
    ];

    const isCasual = casualPatterns.some((pattern) => pattern.test(trimmed));
    return !isCasual;
  }

  /**
   * 方法 `formatReviewGraphResponse` 的职责说明。
   * `formatReviewGraphResponse` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private formatReviewGraphResponse(reviewResult: ReviewGraphRunOutput): string {
    const reportText = formatReportAsText(reviewResult.report);
    const statusEmoji = reviewResult.finalStatus === "passed" ? "✅" :
      reviewResult.finalStatus === "blocked" ? "🚫" :
      reviewResult.finalStatus === "needs_approval" ? "⏸️" : "❌";

    return [
      `${statusEmoji} AgentReview Graph completed with status: **${reviewResult.finalStatus}**`,
      "",
      reportText,
    ].join("\n");
  }
}

/**
 * 函数 `summarizeMemorySources` 的职责说明。
 * `summarizeMemorySources` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

/**
 * 函数 `isRecentMemoryResult` 的职责说明。
 * `isRecentMemoryResult` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

/**
 * 函数 `extractDateFromMemoryPath` 的职责说明。
 * `extractDateFromMemoryPath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function extractDateFromMemoryPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/memory\/(\d{4}-\d{2}-\d{2})\.md$/);
  return match?.[1];
}

/**
 * 函数 `isRecentMemoryDate` 的职责说明。
 * `isRecentMemoryDate` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function isRecentMemoryDate(date: string): boolean {
  const timestamp = Date.parse(`${date}T00:00:00+08:00`);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  return Date.now() - timestamp <= 7 * 86_400_000;
}

/**
 * 函数 `throwIfAborted` 的职责说明。
 * `throwIfAborted` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function sanitizeFallbackText(raw: string): string {
  let text = raw
    .replace(/\uFFFD/g, "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/\[Tool Result\][\s\S]*?\[\/Tool Result\]/g, "")
    .trim();
  if (!text) {
    return "";
  }

  if (text.startsWith("{") && text.endsWith("}")) {
    const parsed = tryParseStructuredPayload(text);
    if (parsed && parsed.type !== "tool_call") {
      const content = extractMeaningfulContent(parsed);
      if (content) return content;
    }
  }

  const ranges = extractStructuredJsonRanges(text)
    .map((range) => ({
      ...range,
      parsed: tryParseStructuredPayload(range.json),
    }));
  const finalPayload = [...ranges]
    .reverse()
    .find(
      (range) =>
        range.parsed?.type === "final" &&
        typeof range.parsed.content === "string" &&
        range.parsed.content.trim() !== ""
    );
  if (finalPayload?.parsed && typeof finalPayload.parsed.content === "string") {
    return finalPayload.parsed.content.trim();
  }

  for (const range of [...ranges].reverse()) {
    if (range.parsed) {
      const content = extractMeaningfulContent(range.parsed);
      if (content && !range.parsed.type) {
        return content;
      }
    }
    if (range.parsed?.type === "tool_call" || range.parsed?.type === "final") {
      text = text.slice(0, range.start) + text.slice(range.end);
    }
  }

  return text
    .replace(/\[Tool Result\][\s\S]*?\[\/Tool Result\]/g, "")
    .replace(/^\[[^\]]*JSON[^\]]*\]\s*$/gim, "")
    .replace(/^\[[^\]]*tool-format-warning[^\]]*\]\s*$/gim, "")
    .replace(/^\[[^\]]*工具未被调用[^\]]*\]\s*$/gim, "")
    .replace(/^\[TOOL_CALL\]\s*/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPlainTextFallbackResponse(
  raw: string,
  toolCalls: GatewayToolCallRecord[]
): string {
  const sanitized = sanitizeFallbackText(raw);
  if (sanitized) {
    return sanitized;
  }

  const successful = toolCalls.filter((toolCall) => toolCall.status === "success");
  const failed = toolCalls.filter((toolCall) => toolCall.status !== "success");
  const successfulWrites = successful.filter(
    (toolCall) =>
      toolCall.toolName === "file.write" ||
      toolCall.toolName === "file.edit" ||
      toolCall.toolName === "file.multi_edit" ||
      toolCall.toolName === "file.patch"
  );
  const successfulRuns = successful.filter(
    (toolCall) => toolCall.toolName === "shell.run"
  );

  const lines: string[] = ["## 任务总结\n"];

  if (successfulWrites.length > 0) {
    const files = successfulWrites
      .map((toolCall) => toolCall.input.path)
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim());
    const summary = files.length > 0 ? files.map((f) => `\`${f}\``).join(", ") : "目标文件";
    lines.push(`### 文件操作\n- ✅ 已完成文件写入：${summary}\n`);
  }

  if (successfulRuns.length > 0) {
    lines.push("### 命令执行\n");
    for (const tc of successfulRuns) {
      const cmd = typeof tc.input.command === "string" ? tc.input.command.slice(0, 80) : "shell.run";
      lines.push(`- ✅ ${cmd}`);
    }
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push("### 失败操作\n");
    for (const tc of failed) {
      lines.push(`- ❌ ${tc.toolName}${tc.error ? `：${tc.error.slice(0, 100)}` : ""}`);
    }
    lines.push("");
  }

  if (toolCalls.length > 0) {
    lines.push(`共执行 **${toolCalls.length}** 个工具调用（${successful.length} 成功，${failed.length} 失败）。`);
    return lines.join("\n");
  }

  return "模型没有返回可执行的最终结果。";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("RUN_CANCELLED");
  }
}

/**
 * 函数 `isAbortError` 的职责说明。
 * `isAbortError` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message === "RUN_CANCELLED" ||
      err.name === "AbortError" ||
      err.message.includes("aborted"))
  );
}
