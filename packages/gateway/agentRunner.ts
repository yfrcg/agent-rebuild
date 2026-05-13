
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { readTranscript } from "../session/src/transcript";
import type { ChatMessage, ModelProvider } from "../model/types";
import { recordUsage, estimateCostCents, getSessionUsage } from "../storage/src/usageStore";
import {
  buildDevTaskSummaryPrompt,
  buildDevTaskSystemHint,
  createDevTaskTracker,
  deserializeDevTaskTracker,
  extractStructuredResult,
  formatStructuredResultForContext,
  isDevTask,
  serializeDevTaskTracker,
  trackToolCall,
  type DevTaskTracker,
} from "./autoToolLoop";
import { ContextBuilder } from "./contextBuilder";
import { ContextCompressor } from "./contextCompressor";
import { SessionMemoryManager } from "./sessionMemoryManager";
import { createGatewayToolCallRequest } from "./toolCallFactory";
import type { GatewayProjectBoundary, GatewayToolCallRecord } from "./toolCallTypes";
import type { ToolCallExecutor } from "./toolCallExecutor";
import type { ToolRegistry } from "./toolRegistry";
import { recordTranscript } from "./transcriptRecorder";
import type {
  GatewayDebugInfo,
  GatewayHandleOptions,
  GatewayRequest,
  MemorySearchResult,
} from "./types";
import { tryParseWithFix, cleanToolCallArtifacts, extractToolCallIntent } from "./textSanitizer";
import { attemptToolCallRecovery } from "./toolCallRecovery";


interface AgentRunnerOptions {
  modelProvider: ModelProvider;
  memorySearch: (query: string) => Promise<MemorySearchResult[]>;
  contextBuilder?: ContextBuilder;
  toolRegistry?: ToolRegistry;
  toolCallExecutor?: ToolCallExecutor;
  auditLogger?: unknown;
  maxToolCalls?: number;
  compressor?: ContextCompressor;
  devTaskMaxSteps?: number;
  devTaskMaxFixRounds?: number;
  sessionTokenBudget?: number;
  sessionCostBudgetCents?: number;
}

interface AgentRunnerResult {
  text: string;
  memoryResults: MemorySearchResult[];
  memorySearchError?: string;
  toolCalls: GatewayToolCallRecord[];
  builtContext: ReturnType<ContextBuilder["buildContext"]>;
  autoToolLoop: GatewayDebugInfo["autoToolLoop"];
  devTask?: GatewayDebugInfo["devTask"];
  plainTextFallback?: boolean;
}

export interface AgentRunnerRunOptions {
  signal?: AbortSignal;
  onEvent?: GatewayHandleOptions["onEvent"];
}

type AgentModelOutput =
  | {
      type: "tool_call";
      tool: string;
      args: Record<string, unknown>;
    }
  | {
      type: "final";
      content: string;
    };

export class AgentRunner {
  private readonly modelProvider: ModelProvider;
  private readonly memorySearch: AgentRunnerOptions["memorySearch"];
  private readonly contextBuilder: ContextBuilder;
  private readonly toolRegistry?: ToolRegistry;
  private readonly toolCallExecutor?: ToolCallExecutor;
  private readonly auditLogger?: unknown;
  private readonly maxToolCalls: number;
  private readonly compressor: ContextCompressor;
  private readonly devTaskMaxSteps: number;
  private readonly devTaskMaxFixRounds: number;
  private readonly sessionTokenBudget: number;
  private readonly sessionCostBudgetCents: number;
  private devTaskTracker?: DevTaskTracker;

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(options: AgentRunnerOptions) {
    this.modelProvider = options.modelProvider;
    this.memorySearch = options.memorySearch;
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder();
    this.toolRegistry = options.toolRegistry;
    this.toolCallExecutor = options.toolCallExecutor;
    this.auditLogger = options.auditLogger;
    this.maxToolCalls = options.maxToolCalls ?? 15;
    this.compressor = options.compressor ?? new ContextCompressor();
    this.devTaskMaxSteps = options.devTaskMaxSteps ?? 30;
    this.devTaskMaxFixRounds = options.devTaskMaxFixRounds ?? 5;
    this.sessionTokenBudget = options.sessionTokenBudget ?? 2_000_000;
    this.sessionCostBudgetCents = options.sessionCostBudgetCents ?? 2000;
  }

  /**
   * 方法 `run` 的职责说明。
   * `run` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  async run(
    request: GatewayRequest,
    options: AgentRunnerRunOptions = {}
  ): Promise<AgentRunnerResult> {
    // Learning note: this is the LLM control loop. One iteration means:
    // build messages -> call model -> parse tool/final JSON -> execute tool or finish.
    throwIfAborted(options.signal);
    const devMode = isDevTask(request.input);
    const devTracker = devMode
      ? (this.restoreDevTaskTracker(request.sessionId) ?? createDevTaskTracker())
      : undefined;
    if (devMode && devTracker) {
      this.devTaskTracker = devTracker;
    }

    let memoryResults: MemorySearchResult[];
    let memorySearchError: string | undefined;
    try {
      memoryResults = await this.memorySearch(request.input);
    } catch (err) {
      memorySearchError = err instanceof Error ? err.message : String(err);
      console.warn("[agentRunner] memorySearch failed, continuing with empty results:", memorySearchError);
      memoryResults = [];
    }
    if (!Array.isArray(memoryResults)) {
      memoryResults = [];
    }
    throwIfAborted(options.signal);

    let sessionMemoryContext = "";
    try {
      const sessionId = request.sessionId;
      if (sessionId) {
        const smm = new SessionMemoryManager(sessionId);
        const wmSummary = smm.buildWorkingMemorySummary();
        const rsSection = smm.buildRollingSummarySection();
        sessionMemoryContext = [wmSummary, rsSection].filter(Boolean).join("\n\n");
      }
    } catch {
      // session memory is best-effort
    }

    const builtContext = this.contextBuilder.buildContext(request.input, memoryResults, {
      activeSkillNames: request.activeSkills,
      permissionMode: request.permissionMode,
      planState: request.planState,
      sessionMemoryContext,
      projectBoundary: request.projectBoundary,
    });
    const transcriptContext = this.buildTranscriptContext(request.sessionId, request.input);

    if (!this.toolRegistry || !this.toolCallExecutor) {
      return {
        text: await this.callModel(
          buildAgentMessages({
            baseMessages: builtContext.messages,
            transcriptContext,
            tools: [],
            toolCalls: [],
            forceFinal: false,
            maxToolCalls: this.maxToolCalls,
            devMode,
            projectBoundary: request.projectBoundary,
          }),
          options,
          true,
          undefined,
          request.sessionId,
          request.id
        ),
        memoryResults,
        memorySearchError,
        toolCalls: [],
        builtContext,
        autoToolLoop: {
          enabled: false,
          attempted: false,
          toolCallCount: 0,
          maxSteps: this.maxToolCalls,
          finishReason: "disabled",
        },
        devTask: devTracker ? this.buildDevTaskDebugInfo(devTracker) : undefined,
      };
    }

    const toolCalls: GatewayToolCallRecord[] = [];
    const availableTools = this.toolRegistry.list();
    const toolDefinitions = availableTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: (tool.schema ?? tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    }));
    const decisionTrace: NonNullable<
      GatewayDebugInfo["autoToolLoop"]
    >["decisionTrace"] = [];
    let lastTestFailed = false;

    for (let step = 0; step < this.maxToolCalls; step += 1) {
      throwIfAborted(options.signal);

      if (request.sessionId) {
        const sessionUsage = getSessionUsage(request.sessionId);
        if (sessionUsage.totalTokens >= this.sessionTokenBudget || sessionUsage.totalCostCents >= this.sessionCostBudgetCents) {
          const budgetExceeded = `⚠️ 会话 Token 预算已耗尽（已用 ${sessionUsage.totalTokens.toLocaleString()} tokens / $${(sessionUsage.totalCostCents / 100).toFixed(2)}）。请开始新会话。`;
          await options.onEvent?.({ type: "chat.delta", delta: budgetExceeded });
          return {
            text: budgetExceeded,
            memoryResults,
            memorySearchError,
            toolCalls,
            builtContext,
            autoToolLoop: {
              enabled: true,
              attempted: true,
              toolCallCount: toolCalls.length,
              maxSteps: this.maxToolCalls,
              finishReason: "budget-exceeded",
              decisionTrace,
            },
          };
        }
      }

      if (devTracker && devTracker.fixRounds >= this.devTaskMaxFixRounds) {
        decisionTrace.push({
          step: step + 1,
          action: "respond",
          reason: `max fix rounds (${this.devTaskMaxFixRounds}) reached`,
        });
        break;
      }

      if (lastTestFailed && devTracker) {
        const backoffMs = computeBackoffMs(devTracker.fixRounds);
        await delay(backoffMs, options.signal);
        lastTestFailed = false;
      }

      const messagesForModel = buildAgentMessages({
        baseMessages: builtContext.messages,
        transcriptContext,
        tools: availableTools,
        toolCalls,
        forceFinal: false,
        maxToolCalls: this.maxToolCalls,
        devMode,
        devTracker,
        projectBoundary: request.projectBoundary,
      });

      this.compressor.runPipeline(messagesForModel);

      const raw = await this.callModel(messagesForModel, options, false, undefined, request.sessionId, request.id, toolDefinitions);
      throwIfAborted(options.signal);
      this.compressor.updateTokenEstimate(raw);

      // DEBUG: Log raw model output
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        fs.appendFileSync("logs/model-debug.log", `\n=== STEP ${step + 1} ${new Date().toISOString()} ===\n${raw.slice(0, 3000)}\n=== END ===\n`);
      } catch {}

      let parsed = tryParseAgentModelOutput(raw);

      // If standard parsing fails, try to extract intent from malformed output
      if (!parsed) {
        const intent = extractToolCallIntent(raw);
        if (intent && this.toolRegistry?.get(intent.tool)) {
          parsed = {
            type: "tool_call",
            tool: intent.tool,
            args: intent.args,
          };
          // DEBUG
          try {
            const fs = await import("node:fs");
            fs.appendFileSync("logs/model-debug.log", `[FALLBACK] extractToolCallIntent succeeded: tool=${intent.tool}\n`);
          } catch {}
        } else {
          // DEBUG
          try {
            const fs = await import("node:fs");
            fs.appendFileSync("logs/model-debug.log", `[FALLBACK] extractToolCallIntent failed. intent=${JSON.stringify(intent)}\n`);
          } catch {}
        }
      }

      if (!parsed) {
        if (step < this.maxToolCalls - 1) {
          messagesForModel.push({ role: "assistant", content: raw });
          messagesForModel.push({
            role: "user",
            content:
              'Your response was plain text or malformed JSON, but you need to use a tool. ' +
              'You MUST respond with ONLY a JSON object, no other text.\n' +
              'To use a tool: {"type":"tool_call","tool":"tool_name","args":{"key":"value"}}\n' +
              'To finish without tools: {"type":"final","content":"your answer"}',
          });
          builtContext.messages.push({ role: "assistant", content: raw });
          builtContext.messages.push({
            role: "user",
            content:
              '请用 JSON 格式回复，不要用纯文本。\n' +
              '调用工具：{"type":"tool_call","tool":"工具名","args":{...}}\n' +
              '结束任务：{"type":"final","content":"你的回答"}',
          });
          decisionTrace.push({
            step: step + 1,
            action: "retry",
            reason: "plain text or malformed output, re-prompting for JSON format",
          });
          continue;
        }
        const grounded = groundFinalResponseToToolEvidence(request.input, raw, toolCalls);
        if (grounded.adjusted && step < this.maxToolCalls - 1) {
          builtContext.messages.push({ role: "assistant", content: raw });
          builtContext.messages.push({
            role: "user",
            content: buildUnsupportedCompletionRetryPrompt(request.input, raw, toolCalls),
          });
          decisionTrace.push({
            step: step + 1,
            action: "retry",
            reason: `plain text unsupported completion: ${grounded.reason}`,
          });
          continue;
        }
        decisionTrace.push({
          step: step + 1,
          action: "respond",
          reason: "model returned plain text",
        });
        return {
          text: grounded.text,
          memoryResults,
          memorySearchError,
          toolCalls,
          builtContext,
          autoToolLoop: {
            enabled: true,
            attempted: true,
            toolCallCount: toolCalls.length,
            maxSteps: this.maxToolCalls,
            finishReason: "plain-text-fallback",
            availableTools: summarizeTools(availableTools),
            decisionTrace,
          },
          devTask: devTracker ? this.buildDevTaskDebugInfo(devTracker) : undefined,
          plainTextFallback: !grounded.adjusted,
        };
      }

      if (parsed.type === "final") {
        // Before accepting final, check if the content contains malformed tool calls
        // that should be extracted and executed instead
        if (step < this.maxToolCalls - 1) {
          const embeddedIntent = extractToolCallIntent(parsed.content);
          if (embeddedIntent && this.toolRegistry?.get(embeddedIntent.tool)) {
            parsed = {
              type: "tool_call",
              tool: embeddedIntent.tool,
              args: embeddedIntent.args,
            };
            // Fall through to tool_call handling below
          }
        }
      }

      if (parsed.type === "final") {
        const rawGrounded = groundFinalResponseToToolEvidence(request.input, parsed.content, toolCalls);
        // Validate the model's original final answer before building a summary, so target-file evidence is not lost.
        if (rawGrounded.adjusted && step < this.maxToolCalls - 1) {
          builtContext.messages.push({ role: "assistant", content: parsed.content });
          builtContext.messages.push({
            role: "user",
            content: buildUnsupportedCompletionRetryPrompt(request.input, parsed.content, toolCalls),
          });
          decisionTrace.push({
            step: step + 1,
            action: "retry",
            reason: `unsupported final completion: ${rawGrounded.reason}`,
            status: "corrected",
          });
          continue;
        }

        let finalContent = parsed.content;
        // Always build a proper Markdown summary from tool calls when tools were used
        if (toolCalls.length > 0) {
          finalContent = buildFinalMarkdownSummary(request.input, toolCalls, finalContent);
        } else if (!finalContent || finalContent.trim().length < 10) {
          const fallback = buildFallbackSummaryFromToolCalls(request.input, toolCalls);
          if (fallback) {
            finalContent = fallback;
          }
        }
        const grounded = groundFinalResponseToToolEvidence(request.input, finalContent, toolCalls);
        if (grounded.adjusted && step < this.maxToolCalls - 1) {
          builtContext.messages.push({ role: "assistant", content: parsed.content });
          builtContext.messages.push({
            role: "user",
            content: buildUnsupportedCompletionRetryPrompt(request.input, parsed.content, toolCalls),
          });
          decisionTrace.push({
            step: step + 1,
            action: "retry",
            reason: `unsupported final completion: ${grounded.reason}`,
            status: "corrected",
          });
          continue;
        }
        decisionTrace.push({
          step: step + 1,
          action: "respond",
          reason: grounded.adjusted
            ? `final response adjusted: ${grounded.reason}`
            : "model returned final response",
          status: grounded.adjusted ? "corrected" : "completed",
        });
        return {
          text: grounded.text,
          memoryResults,
          memorySearchError,
          toolCalls,
          builtContext,
          autoToolLoop: {
            enabled: true,
            attempted: true,
            toolCallCount: toolCalls.length,
            maxSteps: this.maxToolCalls,
            finishReason: "final",
            availableTools: summarizeTools(availableTools),
            decisionTrace,
          },
          devTask: devTracker ? this.buildDevTaskDebugInfo(devTracker, grounded.text) : undefined,
        };
      }

      const toolCallRequest = createGatewayToolCallRequest({
        toolName: parsed.tool,
        input: normalizeRequestedToolArgs(parsed.tool, parsed.args),
        sessionId: request.sessionId,
        requestId: request.id,
        approved: true,
        permissionMode: request.permissionMode,
        planState: request.planState,
        projectBoundary: request.projectBoundary,
        signal: options.signal,
      });
      throwIfAborted(options.signal);
      await options.onEvent?.({
        type: "tool.started",
        toolName: toolCallRequest.toolName,
        toolCallId: toolCallRequest.id,
        inputPreview: toolCallRequest.input,
      });
      this.recordToolTranscript(request.sessionId, "requested", toolCallRequest.toolName, {
        toolCallId: toolCallRequest.id,
        args: toolCallRequest.input,
      });
      await this.writeAudit({
        type: "gateway.agent.tool_call.requested",
        requestId: request.id,
        toolCallId: toolCallRequest.id,
        toolName: toolCallRequest.toolName,
        step: step + 1,
      });

      const toolStartTime = Date.now();
      let toolCallRecord = await this.toolCallExecutor.execute(toolCallRequest);
      throwIfAborted(options.signal);

      // Attempt recovery if tool call failed
      if (toolCallRecord.status !== "success" && toolCallRecord.status !== "denied") {
        try {
          const recovery = await attemptToolCallRecovery(toolCallRecord, toolCallRequest, {
            registry: this.toolRegistry!,
            executor: this.toolCallExecutor!,
            projectRoot: process.cwd(),
            sessionId: request.sessionId,
            requestId: request.id,
            signal: options.signal,
          });

          if (recovery.recovered && recovery.record) {
            toolCallRecord = recovery.record;
            // Log recovery for debugging
            decisionTrace.push({
              step: step + 1,
              action: "tool",
              reason: recovery.suggestion ?? "tool call recovered",
              status: "recovered",
            });
          }
        } catch {
          // Recovery failure should not crash the agent loop
        }
      }

      const toolDurationMs = Date.now() - toolStartTime;
      await options.onEvent?.({
        type:
          toolCallRecord.status === "success"
            ? "tool.finished"
            : toolCallRecord.status === "denied"
              ? "tool.denied"
              : "tool.failed",
        toolCall: toolCallRecord,
      });

      if (
        toolCallRecord.result?.ok &&
        typeof toolCallRecord.result.result === "string"
      ) {
        toolCallRecord.result.result = this.compressor.persistLargeResult(
          toolCallRecord.toolName,
          toolCallRecord.result.result
        );
      }

      if (devTracker && toolCallRecord.result) {
        const rawResult = toolCallRecord.result.result;
        const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult ?? "");
        const structured = extractStructuredResult(
          toolCallRecord.toolName,
          { content: resultStr, isError: !toolCallRecord.result.ok },
          toolDurationMs
        );
        const prevFixRounds = devTracker.fixRounds;
        trackToolCall(devTracker, toolCallRecord.toolName, parsed.args, structured);
        lastTestFailed = devTracker.fixRounds > prevFixRounds;
        this.persistDevTaskTracker(request.sessionId, devTracker);
      }

      toolCalls.push(toolCallRecord);
      decisionTrace.push({
        step: step + 1,
        action: "tool",
        toolName: toolCallRecord.toolName,
        status: toolCallRecord.status,
        error: toolCallRecord.error,
      });
      this.recordToolTranscript(request.sessionId, "completed", toolCallRecord.toolName, {
        toolCallId: toolCallRecord.id,
        ok: toolCallRecord.result?.ok ?? toolCallRecord.output?.ok ?? false,
        riskLevel: toolCallRecord.riskLevel,
        error: toolCallRecord.error,
        durationMs: toolCallRecord.durationMs,
        result: toolCallRecord.result?.result,
      });
      await this.writeAudit({
        type: "gateway.agent.tool_call.completed",
        requestId: request.id,
        toolCallId: toolCallRecord.id,
        toolName: toolCallRecord.toolName,
        step: step + 1,
        riskLevel: toolCallRecord.riskLevel,
        status: toolCallRecord.status,
        ok: toolCallRecord.result?.ok ?? toolCallRecord.output?.ok ?? false,
        error: toolCallRecord.error,
        durationMs: toolDurationMs,
      });

      if (toolCallRecord.toolName === "memory.search" && toolCallRecord.result?.ok) {
        const extraMemory = normalizeMemoryResults(toolCallRecord.result.result);
        memoryResults = mergeMemoryResults(memoryResults, extraMemory);
      }

      // Persist tool call and result to builtContext so the model sees history in next iteration
      let toolResultSummary: string;
      if (toolCallRecord.result?.ok) {
        toolResultSummary = JSON.stringify(toolCallRecord.result.result ?? "ok").slice(0, 2000);
      } else if (toolCallRecord.result?.result) {
        // Include full result (stdout/stderr/exitCode) for failed tools so the model can diagnose
        const fullResult = JSON.stringify(toolCallRecord.result.result).slice(0, 2000);
        toolResultSummary = `Error: ${toolCallRecord.error ?? "unknown"}\nDetails: ${fullResult}`;
      } else {
        toolResultSummary = `Error: ${toolCallRecord.error ?? "unknown"}`;
      }
      builtContext.messages.push({
        role: "assistant",
        content: JSON.stringify({ type: "tool_call", tool: toolCallRecord.toolName, args: parsed.args }),
      });
      builtContext.messages.push({
        role: "user",
        content: `[Tool Result: ${toolCallRecord.toolName}]\n${toolResultSummary}\n[/Tool Result]`,
      });
    }

    if (this.compressor.needsAutoCompact(builtContext.messages)) {
      const summary = `Session had ${toolCalls.length} tool calls. Key results preserved.`;
      builtContext.messages.push({
        role: "user",
        content: `[Context auto-compacted] ${summary}`,
      });
    }

    const finalMessages = buildAgentMessages({
      baseMessages: builtContext.messages,
      transcriptContext,
      tools: availableTools,
      toolCalls,
      forceFinal: true,
      maxToolCalls: this.maxToolCalls,
      devMode,
      devTracker,
      projectBoundary: request.projectBoundary,
    });

    const forcedFinalRaw = await this.callModel(finalMessages, options, false, undefined, request.sessionId, request.id);
    throwIfAborted(options.signal);
    const forcedFinal = tryParseAgentModelOutput(forcedFinalRaw);
    let finalText =
      forcedFinal && forcedFinal.type === "final"
        ? forcedFinal.content
        : forcedFinalRaw;
    // Always build a proper Markdown summary from tool calls when tools were used
    if (toolCalls.length > 0) {
      finalText = buildFinalMarkdownSummary(request.input, toolCalls, finalText);
    } else if (!finalText || finalText.trim().length < 10) {
      const fallback = buildFallbackSummaryFromToolCalls(request.input, toolCalls);
      if (fallback) {
        finalText = fallback;
      }
    }
    const groundedFinal = groundFinalResponseToToolEvidence(request.input, finalText, toolCalls);

    return {
      text: groundedFinal.text,
      memoryResults,
      memorySearchError,
      toolCalls,
      builtContext,
      autoToolLoop: {
        enabled: true,
        attempted: true,
        toolCallCount: toolCalls.length,
        maxSteps: this.maxToolCalls,
        finishReason: "tool-budget-exhausted",
        availableTools: summarizeTools(availableTools),
        decisionTrace,
      },
      devTask: devTracker ? this.buildDevTaskDebugInfo(devTracker, groundedFinal.text) : undefined,
    };
  }

  /**
   * 方法 `callModel` 的职责说明。
   * `callModel` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private async callModel(
    messages: ChatMessage[],
    options: AgentRunnerRunOptions = {},
    streamDeltas = false,
    responseFormat?: { type: "json_object" | "text" },
    sessionId?: string,
    requestId?: string,
    toolDefinitions?: Array<{ name: string; description: string; parameters?: Record<string, unknown> }>
  ): Promise<string> {
    throwIfAborted(options.signal);
    const result = await this.modelProvider.generate(messages, {
      signal: options.signal,
      onDelta: streamDeltas
        ? async (delta) => {
            try {
              // Clean tool call artifacts from delta output
              const cleaned = cleanToolCallArtifacts(delta);
              if (cleaned) {
                await options.onEvent?.({ type: "chat.delta", delta: cleaned });
              }
            } catch {
              // event handler failure should not crash model generation
            }
          }
        : undefined,
      responseFormat,
      tools: toolDefinitions,
    });
    throwIfAborted(options.signal);

    if (result.usage) {
      try {
        const costCents = estimateCostCents(
          this.modelProvider.name,
          result.usage.promptTokens,
          result.usage.completionTokens
        );
        recordUsage({
          id: `usage-${Date.now()}-${randomBytes(4).toString("hex")}`,
          sessionId,
          requestId,
          modelProvider: this.modelProvider.name,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          estimatedCostCents: costCents,
          createdAt: new Date().toISOString(),
        });
      } catch {
        // usage recording is best-effort
      }
    }

    return result.text;
  }

  /**
   * 从 transcript 中提取历史对话，转换为 ChatMessage[] 格式。
   *
   * 核心逻辑：
   * - user/assistant 消息直接转为对应 role 的 ChatMessage
   * - tool/system 消息跳过（属于内部流程，不应暴露给模型）
   * - 最后一条与 currentInput 相同的 user 消息跳过（避免重复）
   * - 从最新的消息向前选取，总字符数不超过 MAX_TRANSCRIPT_CHARS
   *
   * 这样模型看到的是正常的对话历史，而不是一段扁平的文本，
   * 从而避免模型误以为用户在反复强调同一个问题。
   */
  private buildTranscriptContext(
    sessionId: string | undefined,
    currentInput: string
  ): ChatMessage[] | undefined {
    if (!sessionId) {
      return undefined;
    }

    const MAX_TRANSCRIPT_CHARS = 8000;
    const MAX_MSG_CHARS = 1000;

    const entries = readTranscript(sessionId)
      .filter((e) => e.role === "user" || e.role === "assistant");

    if (entries.length === 0) {
      return undefined;
    }

    const cleaned = entries.flatMap((e) => {
      if (
        e.role === "assistant" &&
        (/\[TOOL_CALL\]/i.test(e.content) || /"type"\s*:\s*"tool_call"/i.test(e.content))
      ) {
        return [];
      }

      let content = sanitizeInjectedContextText(e.content.replace(/\s+/g, " ").trim());
      if (!content) {
        return [];
      }
      if (content.length > MAX_MSG_CHARS) {
        content = content.slice(0, MAX_MSG_CHARS) + "...";
      }
      return [{ role: e.role as "user" | "assistant", content }];
    });

    const lastIdx = cleaned.length - 1;
    if (
      cleaned[lastIdx].role === "user" &&
      cleaned[lastIdx].content === currentInput.replace(/\s+/g, " ").trim()
    ) {
      cleaned.splice(lastIdx, 1);
    }

    if (cleaned.length === 0) {
      return undefined;
    }

    const selected: ChatMessage[] = [];
    let usedChars = 0;
    for (let i = cleaned.length - 1; i >= 0; i--) {
      const msg = cleaned[i];
      if (usedChars + msg.content.length > MAX_TRANSCRIPT_CHARS && selected.length > 0) {
        break;
      }
      selected.unshift({ role: msg.role, content: msg.content });
      usedChars += msg.content.length;
    }

    return selected.length > 0 ? selected : undefined;
  }

  /**
   * 方法 `recordToolTranscript` 的职责说明。
   * `recordToolTranscript` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private recordToolTranscript(
    sessionId: string | undefined,
    phase: "requested" | "completed",
    toolName: string,
    metadata: Record<string, unknown>
  ): void {
    if (!sessionId) {
      return;
    }

    const statusText =
      phase === "requested"
        ? `[agent.tool.requested] ${toolName}`
        : `[agent.tool.completed] ${toolName}`;
    recordTranscript(sessionId, "tool", statusText, metadata);
  }

  /**
   * 方法 `writeAudit` 的职责说明。
   * `writeAudit` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private async writeAudit(data: Record<string, unknown>): Promise<void> {
    if (!this.auditLogger) {
      return;
    }

    const logger = this.auditLogger as {
      log?: (event: unknown) => Promise<void> | void;
      record?: (event: unknown) => Promise<void> | void;
      append?: (event: unknown) => Promise<void> | void;
      write?: (event: unknown) => Promise<void> | void;
    };
    const event = {
      id: `agent-runner-${Date.now()}-${randomBytes(6).toString("hex")}`,
      createdAt: new Date().toISOString(),
      message: String(data.type ?? "gateway.agent"),
      ...data,
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
  }

  /**
   * 方法 `buildDevTaskDebugInfo` 的职责说明。
   * `buildDevTaskDebugInfo` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private buildDevTaskDebugInfo(
    tracker: DevTaskTracker,
    finalText?: string
  ): GatewayDebugInfo["devTask"] {
    const testsPassed = tracker.testResults.filter((r) => r.passed).length;
    const testsFailed = tracker.testResults.filter((r) => !r.passed).length;
    const lastTestFailed =
      tracker.testResults.length > 0 &&
      !tracker.testResults[tracker.testResults.length - 1].passed;
    const allTestsPassed =
      tracker.testResults.length > 0 && testsFailed === 0;
    const status: "running" | "passed" | "failed" | "stopped" = allTestsPassed
      ? "passed"
      : lastTestFailed
        ? "failed"
        : tracker.testResults.length === 0
          ? "running"
          : "failed";

    return {
      active: true,
      devTaskMode: true,
      maxSteps: this.devTaskMaxSteps,
      currentStep: tracker.commandsRun.length + tracker.testResults.length,
      filesModified: [...tracker.filesModified],
      commandsRun: tracker.commandsRun.length,
      testsPassed,
      testsFailed,
      testResults: tracker.testResults,
      fixRounds: tracker.fixRounds,
      maxFixRounds: this.devTaskMaxFixRounds,
      finalSummary: finalText,
      status,
    };
  }

  /**
   * 方法 `restoreDevTaskTracker` 的职责说明。
   * `restoreDevTaskTracker` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private restoreDevTaskTracker(sessionId: string | undefined): DevTaskTracker | undefined {
    if (!sessionId) return undefined;
    const entries = readTranscript(sessionId);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.metadata && typeof entry.metadata === "object") {
        const meta = entry.metadata as Record<string, unknown>;
        if (meta.devTaskTracker) {
          return deserializeDevTaskTracker(meta.devTaskTracker);
        }
      }
    }
    return undefined;
  }

  /**
   * 方法 `persistDevTaskTracker` 的职责说明。
   * `persistDevTaskTracker` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private persistDevTaskTracker(sessionId: string | undefined, tracker: DevTaskTracker): void {
    if (!sessionId) return;
    recordTranscript(sessionId, "system", "[dev_task_tracker]", {
      devTaskTracker: serializeDevTaskTracker(tracker),
    });
  }
}

/**
 * 函数 `delay` 的职责说明。
 * `delay` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("RUN_CANCELLED"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("RUN_CANCELLED"));
      },
      { once: true }
    );
  });
}

/**
 * 函数 `computeBackoffMs` 的职责说明。
 * `computeBackoffMs` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function computeBackoffMs(fixRounds: number): number {
  const base = 500;
  const max = 8000;
  return Math.min(base * Math.pow(2, fixRounds - 1), max);
}

/**
 * 函数 `buildAgentMessages` 的职责说明。
 * `buildAgentMessages` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function sanitizeInjectedContextText(text: string): string {
  return text
    .replace(/\bdir\s*\/b\s+([^\s][^"`']*)/gi, "Get-ChildItem -Name -Path $1")
    .replace(/\bdir\s*\/b\b/gi, "Get-ChildItem -Name")
    .replace(/\bcmd\s*\/c\b/gi, "powershell -Command")
    .replace(/\btype\s+([^\s][^"`']*)/gi, "Get-Content $1")
    .replace(/\brmdir\s+\/s\s+\/q\s+([^\s][^"`']*)/gi, "Remove-Item -Recurse -Force $1")
    .replace(/\bdel\s+([^\s][^"`']*)/gi, "Remove-Item -Force $1")
    .replace(/\bcopy\s+([^\s]+)\s+([^\s][^"`']*)/gi, "Copy-Item $1 $2")
    .replace(/\bmove\s+([^\s]+)\s+([^\s][^"`']*)/gi, "Move-Item $1 $2");
}

function normalizeRequestedToolArgs(
  _toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  return args;
}

function buildAgentMessages(input: {
  baseMessages: ChatMessage[];
  transcriptContext?: ChatMessage[];
  tools: ReturnType<ToolRegistry["list"]>;
  toolCalls: GatewayToolCallRecord[];
  forceFinal: boolean;
  maxToolCalls: number;
  devMode?: boolean;
  devTracker?: DevTaskTracker;
  projectBoundary?: GatewayProjectBoundary;
}): ChatMessage[] {
  const messages = [...input.baseMessages];
  let insertionIndex = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "system") {
      insertionIndex = index + 1;
      break;
    }
  }

  const supplemental: ChatMessage[] = [];

  if (input.devMode) {
    supplemental.push({
      role: "system",
      content: buildDevTaskSystemHint(),
    });
  }

  const toolCallBudget = Math.max(0, input.maxToolCalls - input.toolCalls.length);

  const toolCallSummaryLines = input.toolCalls.map((toolCall) => {
    const rawResult = toolCall.result?.result ?? toolCall.output?.content;
    const resultContent = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult ?? "");
    const structured = extractStructuredResult(
      toolCall.toolName,
      { content: resultContent, isError: !toolCall.result?.ok },
    );
    return formatStructuredResultForContext(structured);
  });

  const projectToolGuidance = buildProjectToolGuidance(input.projectBoundary);
  const systemContent = [
    "═══════════════════════════════════════════════════",
    "  Agent Tool Loop v0.3",
    "═══════════════════════════════════════════════════",
    "",
    input.forceFinal
      ? [
          "所有工具调用已完成。请用自然语言（Markdown 格式）回复用户。",
          "绝对不要返回 JSON。直接用 Markdown 写你的最终回答。",
          "",
          "⚠️ 你的回答必须包含以下内容（缺一不可）：",
          "1. 本次任务的目标是什么",
          "2. 你具体做了哪些操作（创建/修改了哪些文件、运行了哪些命令）",
          "3. 每个操作的结果如何（成功/失败、输出内容）",
          "4. 如有测试，测试结果是什么",
          "",
          "格式示例：",
          "## 任务总结",
          "",
          "### 创建文件",
          "- 创建了 `hello.py`，内容为 `print('Hello')`",
          "",
          "### 执行结果",
          "- 运行 `python hello.py`，输出：",
          "```",
          "Hello",
          "```",
          "",
          "### 结论",
          "任务完成，程序运行正常。",
        ].join("\n")
      : [
          "你需要调用工具来完成任务。每次回复只能包含一个 JSON 对象，不要添加其他文字。",
          "",
          "▸ 调用工具：",
          '  {"type":"tool_call","tool":"工具名","args":{"参数名":"值"}}',
          "",
          "▸ 结束任务 / 直接回答：",
          '  {"type":"final","content":"用 Markdown 格式写的回答"}',
          "",
          "⚠️ content 字段必须是 Markdown 格式的自然语言总结，不是 JSON。",
          "⚠️ content 不能为空，必须包含：你做了什么、结果如何、是否成功。",
          "",
          "▸ 重要规则：",
          "  - 如果用户的问题不需要工具操作（例如问你能做什么、问某个概念、闲聊），",
          "    直接返回 {\"type\":\"final\",\"content\":\"你的回答\"}，不要调用工具。",
          "  - 只有当用户要求你执行具体操作（创建文件、运行命令、读取文件等）时，才调用工具。",
          "",
          "▸ 示例 1（需要工具）：",
          "  用户：帮我创建一个 hello.py",
          `  你：{"type":"tool_call","tool":"file.write","args":{"path":"hello.py","content":"print('Hello')\\n"}}`,
          "  [系统返回工具结果]",
          `  你：{"type":"final","content":"## 完成\\n\\n已创建 hello.py，内容为 print('Hello')。文件写入成功。"}`,
          "",
          "▸ 示例 2（需要工具）：",
          "  用户：运行这个文件",
          `  你：{"type":"tool_call","tool":"shell.run","args":{"command":"python hello.py","cwd":"D:\\\\WorkStation\\\\CoLab"}}`,
          "  [系统返回运行结果]",
          `  你：{"type":"final","content":"## 运行结果\\n\\n执行 python hello.py 输出：\\n\`\`\`\\nHello\\n\`\`\`\\n程序运行正常。"}`,
          "",
          "▸ 示例 3（纯对话，不需要工具）：",
          "  用户：你能做什么？",
          `  你：{"type":"final","content":"## 我能做的操作\\n\\n- **file.write** — 创建或覆盖文件\\n- **file.read** — 读取文件内容\\n- **file.list** — 列出目录文件\\n- **shell.run** — 执行命令\\n- **memory.search** — 搜索记忆\\n- **web.search** — 搜索网页\\n- **web.fetch** — 获取网页内容"}`,
        ].join("\n"),
    "",
    "═══ Windows 环境（必须遵守）═══",
    "当前系统是 Windows，shell.run 通过 PowerShell 执行。",
    "",
    "⚠️ 绝对不要使用 Linux 命令！以下命令会失败：",
    "  ❌ ls, cat, rm -rf, mkdir -p, cp, mv, touch, echo > file",
    "  ❌ dir, dir /b, type, del, copy, move, rmdir /s /q, cmd /c",
    "",
    "✅ 必须使用以下 Windows/PowerShell 命令：",
    "  查看目录: Get-ChildItem",
    "  查看文件: Get-Content file.txt",
    "  创建目录: New-Item -ItemType Directory -Path dir",
    "  删除文件: Remove-Item -Force file",
    "  删除目录: Remove-Item -Recurse -Force dir",
    "  复制文件: Copy-Item src dst",
    "  移动文件: Move-Item src dst",
    "",
    "⚠️ 创建文件必须用 file.write 工具，不要用 shell！",
    "⚠️ 路径使用反斜杠 \\，例如 D:\\WorkStation\\CoLab\\hello.cpp",
    "⚠️ 运行 Python: python script.py 或 py script.py",
    "⚠️ 运行 C++: 先用 file.write 创建文件，再用 shell.run 编译运行",
    "⚠️ 如果记忆、历史 transcript 或旧日志里出现 dir/type/cmd 写法，一律视为过时内容，不要沿用。",
    `工具调用预算：${toolCallBudget}/${input.maxToolCalls}`,
    "",
    "可用工具：",
    JSON.stringify(
      input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        schema: tool.schema ?? tool.inputSchema ?? {},
      })),
      null,
      2
    ),
    "",
    "已执行的工具调用：",
    toolCallSummaryLines.length === 0
      ? "(无)"
      : toolCallSummaryLines.join("\n---\n"),
    "",
    projectToolGuidance,
    "如工具调用失败，请仔细阅读错误信息并调整路径或方法。",
    "",
    "═══ 反幻觉规则（必须遵守）═══",
    "1. 绝对不要声称你看到了某个文件的内容，除非你刚刚用 file.read 或 file.list 工具读取过。",
    "2. 绝对不要编造文件内容、目录结构或命令输出。",
    "3. 如果用户问某个文件是否存在，优先用 file.list 或 file.read 工具检查；只有确实需要执行命令时才用 shell.run。",
    "4. 如果你不确定某个信息，必须用工具验证后再回答。",
    "5. 回答时只基于工具返回的实际结果，不要凭记忆或推测。",
    "",
    "═══ 工具信任层级 ═══",
    "file.list 和 file.read 是文件系统事实的首选来源。",
    "shell.run 主要用于编译、运行、测试、环境探测，不要拿它替代常规文件工具。",
    "如果 shell.run 和 file.list 结果有冲突，先重新读取相关路径，不要直接宣布结论。",
    "对文件存在性或目录内容有疑问时，优先重新调用 file.list / file.read。",
    "",
    "═══════════════════════════════════════════════════",
  ].join("\n");

  supplemental.push({ role: "system", content: systemContent });

  if (input.devTracker && input.devTracker.testResults.length > 0) {
    const hasFailure = input.devTracker.testResults.some((t) => !t.passed);
    if (hasFailure) {
      supplemental.push({
        role: "user",
        content: buildDevTaskSummaryPrompt(input.devTracker),
      });
    }
  }

  messages.splice(insertionIndex, 0, ...supplemental);

  if (input.transcriptContext && input.transcriptContext.length > 0) {
    const lastSystemIdx = messages.reduce((acc, m, i) => m.role === "system" ? i : acc, -1);
    const transcriptInsertAt = lastSystemIdx >= 0 ? lastSystemIdx + 1 : 0;
    messages.splice(transcriptInsertAt, 0, ...input.transcriptContext);
  }

  return messages;
}

function buildProjectToolGuidance(projectBoundary?: GatewayProjectBoundary): string {
  if (projectBoundary?.projectDir) {
    return [
      `Current projectDir for file tools and shell cwd: ${projectBoundary.projectDir}`,
      `Allowed write roots: ${
        projectBoundary.allowedWriteRoots.length
          ? projectBoundary.allowedWriteRoots.join("; ")
          : projectBoundary.projectDir
      }`,
      "For file.write, use a relative path inside projectDir, for example file.write({path: \"hello.py\", content: \"print('Hello World')\\n\"}).",
      "For shell.run, set cwd to the current projectDir when a cwd is needed.",
      "Do not route project file creation through D:\\WorkStation\\agent-rebuild\\workspace while a projectDir is bound.",
    ].join("\n");
  }

  return [
    "For shell.run, set cwd to a Windows path such as D:\\WorkStation\\agent-rebuild.",
    "Do not use /workspace or POSIX-style paths. Always use Windows paths such as D:\\WorkStation\\agent-rebuild\\workspace.",
    "The workspace directory for creating new files is: D:\\WorkStation\\agent-rebuild\\workspace",
    "When creating new files, use a relative path like workspace/filename.ext or an absolute Windows path.",
    "Example to create a Python file: file.write({path: \"workspace/hello.py\", content: \"print('Hello World')\"})",
    "To list files in the workspace, use file.list({path: \"workspace\"}).",
  ].join("\n");
}

/**
 * 函数 `tryParseAgentModelOutput` 的职责说明。
 * `tryParseAgentModelOutput` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function groundFinalResponseToToolEvidence(
  requestInput: string,
  responseText: string,
  toolCalls: GatewayToolCallRecord[]
): { text: string; adjusted: boolean; reason?: string } {
  const issue = detectUnsupportedFinalClaims(requestInput, responseText, toolCalls);
  if (!issue) {
    return { text: responseText, adjusted: false };
  }

  const successfulTools = toolCalls.filter((toolCall) => toolCall.status === "success");
  const successfulMutations = successfulTools.filter((toolCall) => isFileMutationToolName(toolCall.toolName));
  const successfulExecutions = successfulTools.filter((toolCall) => isExecutionToolName(toolCall.toolName));
  const failedTools = toolCalls.filter((toolCall) => toolCall.status !== "success");

  const bulletLines = successfulTools.length === 0
    ? ["- 没有成功的工具调用。"]
    : successfulTools.map((toolCall) => `- ${summarizeToolEvidence(toolCall)}`);
  const lines = [
    "我不能确认刚才那条“已完成”的结论。",
    `原因：${issue.reason}`,
    "",
    "本轮实际工具结果：",
    ...bulletLines,
  ];

  if (failedTools.length > 0) {
    lines.push("", "失败的工具调用：");
    lines.push(...failedTools.map((toolCall) => `- ${summarizeToolFailure(toolCall)}`));
  }

  if (issue.kind === "file-claim" && successfulMutations.length === 0) {
    lines.push("", "目前没有证据表明文件已被创建或写入。");
  }
  if (issue.kind === "execution-claim" && successfulExecutions.length === 0) {
    lines.push("", "目前没有证据表明程序已成功编译、运行或产出该输出。");
  }

  lines.push("", "应先完成对应的 `file.write` / `shell.run`，再声明成功。");

  return {
    text: lines.join("\n").trim(),
    adjusted: true,
    reason: issue.reason,
  };
}

function buildUnsupportedCompletionRetryPrompt(
  requestInput: string,
  responseText: string,
  toolCalls: GatewayToolCallRecord[]
): string {
  const issue = detectUnsupportedFinalClaims(requestInput, responseText, toolCalls);
  const mentionedFiles = extractMentionedFiles(responseText);
  const fileHint = mentionedFiles.length > 0 ? ` Target file: ${mentionedFiles.join(", ")}.` : "";

  if (issue?.kind === "execution-claim") {
    return [
      "Your last response claimed compile/run/output success without tool evidence.",
      "Continue the task instead of finishing.",
      "Respond with ONLY one JSON tool_call.",
      "If the file is not created yet, create or update it first with file.write or file.edit.",
      "If the file already exists, your next step should be an execution tool such as shell.run.",
      "Do not claim success until the corresponding tool call succeeds.",
      fileHint,
    ].join(" ").trim();
  }

  return [
    "You have not created or written the requested file yet.",
    "Continue the task instead of finishing.",
    "Respond with ONLY one JSON tool_call.",
    "Your next step should create or update the file with file.write or file.edit.",
    "Do not spend more steps only inspecting the directory unless a write attempt has already happened.",
    "Do not claim success until the file write succeeds.",
    fileHint,
  ].join(" ").trim();
}

function isReadOnlyToolName(toolName: string): boolean {
  return (
    toolName === "file.list" ||
    toolName === "file.read" ||
    toolName === "memory.search" ||
    toolName === "web.search" ||
    toolName === "web.fetch"
  );
}

function detectUnsupportedFinalClaims(
  requestInput: string,
  responseText: string,
  toolCalls: GatewayToolCallRecord[]
): { kind: "file-claim" | "execution-claim"; reason: string } | undefined {
  const successfulTools = toolCalls.filter((toolCall) => toolCall.status === "success");
  const successfulMutations = successfulTools.filter((toolCall) => isFileMutationToolName(toolCall.toolName));
  const successfulExecutions = successfulTools.filter((toolCall) => isExecutionToolName(toolCall.toolName));
  const onlyReadOnlyEvidence =
    successfulTools.length > 0 && successfulTools.every((toolCall) => isReadOnlyToolName(toolCall.toolName));

  const mentionedFiles = extractMentionedFiles(responseText);
  const touchedFiles = new Set(
    successfulMutations
      .flatMap((toolCall) => extractTouchedPaths(toolCall))
      .map((filePath) => path.basename(filePath).toLowerCase())
  );

  const claimsFileCreation =
    mentionedFiles.length > 0 &&
    /(已创建|已生成|已保存|已写入|文件位置|创建成功|写入成功|保存成功|成功创建|成功写入|成功生成|已完成创建|创建均成功|created|generated|saved|written|wrote|file created|created successfully|saved successfully|written successfully)/i.test(responseText);
  const claimsExecution =
    /(测试结果|运行输出|编译成功|运行成功|执行结果|compiled|compile success|ran successfully|program output|output:)/i.test(responseText) ||
    (/```/.test(responseText) && /(输出|output|result|结果)/i.test(responseText));

  if (
    claimsFileCreation &&
    mentionedFiles.some((fileName) => !touchedFiles.has(fileName.toLowerCase()))
  ) {
    return {
      kind: "file-claim",
      reason: "最终回答声称文件已创建或保存，但本轮没有对应的成功写文件工具结果。",
    };
  }

  if (claimsExecution && successfulExecutions.length === 0) {
    return {
      kind: "execution-claim",
      reason: "最终回答声称程序已编译、运行或给出了输出，但本轮没有对应的成功执行结果。",
    };
  }

  if (
    successfulTools.length > 0 &&
    mentionedFiles.length > 0 &&
    successfulMutations.length === 0 &&
    /(cpp|python|程序|program|script|文件)/i.test(requestInput) &&
    /(已完成|完成了|done|completed)/i.test(responseText)
  ) {
    return {
      kind: "file-claim",
      reason: "最终回答给出了完成态结论，但本轮只有读取类工具，没有实际写入证据。",
    };
  }

  if (
    onlyReadOnlyEvidence &&
    successfulMutations.length === 0 &&
    requestLikelyNeedsFileMutation(requestInput) &&
    /(done|completed|finished|created|generated|saved|written|implemented|fixed|successfully|任务完成|已完成|已创建|已生成|已保存|已写入|创建成功|生成成功|保存成功|写入成功)/i.test(responseText)
  ) {
    return {
      kind: "file-claim",
      reason: "The final response claims completion, but only read-only tools succeeded and no file mutation is evidenced.",
    };
  }

  return undefined;
}

function requestLikelyNeedsFileMutation(requestInput: string): boolean {
  const asksForCodeArtifact =
    /\.(?:cpp|cc|cxx|c|py|js|ts|tsx|jsx|java|cs|go|rs|php|rb|txt|md|json)\b/i.test(requestInput) ||
    /(cpp|python|javascript|typescript|program|script|file|code|程序|脚本|文件|代码)/i.test(requestInput);
  const asksForMutation =
    /(create|write|generate|save|implement|add|fix|modify|update|build|design|创建|写|生成|保存|实现|新增|修复|修改|设计)/i.test(requestInput);

  // Read-only tools cannot prove that a requested code/file artifact was created.
  return asksForCodeArtifact && asksForMutation;
}

function extractMentionedFiles(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_.-]+\.(?:cpp|cc|cxx|c|py|js|ts|tsx|jsx|java|cs|go|rs|php|rb|txt|md|json|exe)/gi) ?? [];
  return [...new Set(matches)];
}

function extractTouchedPaths(toolCall: GatewayToolCallRecord): string[] {
  const paths = new Set<string>();
  const content =
    toolCall.output?.content && typeof toolCall.output.content === "object"
      ? toolCall.output.content as Record<string, unknown>
      : undefined;
  const metadata = toolCall.output?.metadata;
  const resultPayload =
    toolCall.result?.result && typeof toolCall.result.result === "object"
      ? toolCall.result.result as Record<string, unknown>
      : undefined;

  for (const candidate of [content?.path, metadata?.path, resultPayload?.path, toolCall.input.path]) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      paths.add(candidate.trim());
    }
  }

  return [...paths];
}

function summarizeToolEvidence(toolCall: GatewayToolCallRecord): string {
  const pathPreview = extractTouchedPaths(toolCall).map((filePath) => path.basename(filePath)).join(", ");
  if (pathPreview) {
    return `${toolCall.toolName} 成功 (${pathPreview})`;
  }

  if (isExecutionToolName(toolCall.toolName)) {
    const result =
      toolCall.result?.result && typeof toolCall.result.result === "object"
        ? toolCall.result.result as Record<string, unknown>
        : undefined;
    const stdoutPreview =
      typeof result?.stdoutPreview === "string"
        ? truncate(result.stdoutPreview.replace(/\s+/g, " ").trim(), 80)
        : undefined;
    return stdoutPreview
      ? `${toolCall.toolName} 成功 (stdout: ${stdoutPreview})`
      : `${toolCall.toolName} 成功`;
  }

  return `${toolCall.toolName} 成功`;
}

function summarizeToolFailure(toolCall: GatewayToolCallRecord): string {
  return `${toolCall.toolName} 失败${toolCall.error ? `: ${truncate(toolCall.error, 120)}` : ""}`;
}

function isFileMutationToolName(toolName: string): boolean {
  return (
    toolName === "file.write" ||
    toolName === "file.edit" ||
    toolName === "file.multi_edit" ||
    toolName === "file.patch"
  );
}

function isExecutionToolName(toolName: string): boolean {
  return (
    toolName === "shell.run" ||
    toolName === "bash.run" ||
    toolName === "run_test" ||
    toolName === "npm_test" ||
    toolName === "build"
  );
}

/**
 * Build a comprehensive Markdown summary from tool calls.
 * This is the primary summary builder used when the model finishes a task.
 * It generates a clean, structured Markdown report from actual tool execution results.
 */
function buildFinalMarkdownSummary(
  requestInput: string,
  toolCalls: GatewayToolCallRecord[],
  modelResponse?: string
): string {
  if (toolCalls.length === 0) {
    return modelResponse || "";
  }

  const successful = toolCalls.filter((tc) => tc.status === "success");
  const failed = toolCalls.filter((tc) => tc.status !== "success");
  const fileWrites = successful.filter((tc) => isFileMutationToolName(tc.toolName));
  const fileReads = successful.filter((tc) => tc.toolName === "file.read" || tc.toolName === "file.list" || tc.toolName === "file.glob" || tc.toolName === "file.grep");
  const executions = successful.filter((tc) => isExecutionToolName(tc.toolName));
  const memoryOps = successful.filter((tc) => tc.toolName === "memory.search" || tc.toolName === "memory.write");
  const others = successful.filter((tc) =>
    !fileWrites.includes(tc) && !fileReads.includes(tc) && !executions.includes(tc) && !memoryOps.includes(tc)
  );

  const lines: string[] = [];

  // Header
  lines.push("## 任务完成\n");

  // Goal
  lines.push(`**目标：** ${requestInput.slice(0, 300)}\n`);

  // File operations
  if (fileWrites.length > 0) {
    lines.push("### 文件操作\n");
    for (const tc of fileWrites) {
      const paths = extractTouchedPaths(tc);
      const pathStr = paths.length > 0
        ? paths.map((p) => `\`${p}\``).join(", ")
        : "目标文件";
      const action = tc.toolName === "file.write" ? "创建" : tc.toolName === "file.edit" ? "编辑" : "修改";
      lines.push(`- ✅ ${action} ${pathStr}`);
    }
    lines.push("");
  }

  // Command executions
  if (executions.length > 0) {
    lines.push("### 命令执行\n");
    for (const tc of executions) {
      const cmd = typeof tc.input.command === "string" ? truncate(tc.input.command, 100) : tc.toolName;
      const resultObj = tc.result?.result && typeof tc.result.result === "object"
        ? tc.result.result as Record<string, unknown>
        : undefined;
      const exitCode = typeof resultObj?.exitCode === "number" ? resultObj.exitCode : undefined;
      const stdout = typeof resultObj?.stdoutPreview === "string" ? truncate(resultObj.stdoutPreview, 200) : "";
      const statusIcon = exitCode === 0 ? "✅" : exitCode !== undefined ? "⚠️" : "✅";
      lines.push(`- ${statusIcon} \`${cmd}\``);
      if (stdout) {
        lines.push(`  \`\`\`\n  ${stdout}\n  \`\`\``);
      }
    }
    lines.push("");
  }

  // Failed operations
  if (failed.length > 0) {
    lines.push("### 失败操作\n");
    for (const tc of failed) {
      const err = tc.error ? truncate(tc.error, 120) : "未知错误";
      lines.push(`- ❌ **${tc.toolName}**：${err}`);
    }
    lines.push("");
  }

  // Statistics
  lines.push(`---\n`);
  lines.push(`共执行 **${toolCalls.length}** 个工具调用（${successful.length} 成功，${failed.length} 失败）。`);

  return lines.join("\n");
}

function buildFallbackSummaryFromToolCalls(
  requestInput: string,
  toolCalls: GatewayToolCallRecord[]
): string {
  if (toolCalls.length === 0) return "";

  const successful = toolCalls.filter((tc) => tc.status === "success");
  const failed = toolCalls.filter((tc) => tc.status !== "success");
  const fileWrites = successful.filter((tc) => isFileMutationToolName(tc.toolName));
  const executions = successful.filter((tc) => isExecutionToolName(tc.toolName));
  const searches = successful.filter((tc) => tc.toolName === "memory.search" || tc.toolName === "file.read" || tc.toolName === "file.list");
  const others = successful.filter((tc) => !fileWrites.includes(tc) && !executions.includes(tc) && !searches.includes(tc));

  const lines: string[] = [];
  lines.push("## 任务总结\n");
  lines.push(`**目标：** ${requestInput.slice(0, 200)}\n`);

  if (fileWrites.length > 0) {
    lines.push("### 文件操作\n");
    for (const tc of fileWrites) {
      const paths = extractTouchedPaths(tc);
      const pathStr = paths.length > 0 ? paths.map((p) => `\`${path.basename(p)}\``).join(", ") : "目标文件";
      lines.push(`- ✅ **${tc.toolName}** → ${pathStr}`);
    }
    lines.push("");
  }

  if (executions.length > 0) {
    lines.push("### 命令执行\n");
    for (const tc of executions) {
      const cmd = typeof tc.input.command === "string" ? truncate(tc.input.command, 80) : "";
      const resultObj = tc.result?.result && typeof tc.result.result === "object" ? tc.result.result as Record<string, unknown> : undefined;
      const exitCode = typeof resultObj?.exitCode === "number" ? resultObj.exitCode : undefined;
      const stdout = typeof resultObj?.stdoutPreview === "string" ? truncate(resultObj.stdoutPreview, 120) : "";
      const statusIcon = exitCode === 0 ? "✅" : exitCode !== undefined ? "⚠️" : "✅";
      lines.push(`- ${statusIcon} **${cmd}**`);
      if (stdout) {
        lines.push(`  \`\`\`\n  ${stdout}\n  \`\`\``);
      }
    }
    lines.push("");
  }

  if (others.length > 0) {
    lines.push("### 其他操作\n");
    for (const tc of others) {
      lines.push(`- ✅ **${tc.toolName}**`);
    }
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push("### 失败操作\n");
    for (const tc of failed) {
      const err = tc.error ? truncate(tc.error, 100) : "未知错误";
      lines.push(`- ❌ **${tc.toolName}**：${err}`);
    }
    lines.push("");
  }

  const allTestsPassed = executions.some((tc) => {
    const r = tc.result?.result && typeof tc.result.result === "object" ? tc.result.result as Record<string, unknown> : undefined;
    return typeof r?.exitCode === "number" && r.exitCode === 0;
  });
  if (allTestsPassed) {
    lines.push("> ✅ **所有测试通过。**\n");
  }

  lines.push(`共执行 **${toolCalls.length}** 个工具调用（${successful.length} 成功，${failed.length} 失败）。`);
  return lines.join("\n");
}

export function tryParseAgentModelOutput(raw: string): AgentModelOutput | undefined {
  const structuredObjects = extractStructuredJsonObjects(raw);
  const parsedOutputs = structuredObjects
    .map((candidate) => parseAgentOutputObject(candidate))
    .filter((candidate): candidate is AgentModelOutput => candidate !== undefined);

  const toolCalls = parsedOutputs.filter((candidate) => candidate.type === "tool_call");
  if (toolCalls.length > 0) {
    // Prefer mutation tools (file.write, shell.run) over read-only tools (file.list, file.read)
    // This handles cases where the model generates multiple tool calls in one response
    const mutationTools = ["file.write", "file.edit", "file.multi_edit", "file.patch", "shell.run", "memory.write", "todo.write"];
    const preferred = toolCalls.find((tc) => tc.type === "tool_call" && mutationTools.includes(tc.tool));
    if (preferred) return preferred;
    return toolCalls[0];
  }

  const finalOutput = parsedOutputs.find((candidate) => candidate.type === "final");
  if (finalOutput) {
    return finalOutput;
  }

  const regexFallback = tryRegexExtractToolCall(raw);
  if (regexFallback) {
    return regexFallback;
  }

  return undefined;
}

function parseAgentOutputObject(rawObject: string): AgentModelOutput | undefined {
  const parsed = tryParseWithFix(rawObject);
  if (!parsed) return undefined;

  const typeValue = typeof parsed.type === "string" ? parsed.type.trim() : "";
  const isExplicitToolCall = typeValue === "tool_call" || typeValue === "tool";

  if (isExplicitToolCall && typeof parsed.tool === "string" && parsed.tool.trim() !== "") {
    const args = (parsed.args ?? parsed.params ?? parsed.input ?? parsed.arguments) as Record<string, unknown> | undefined;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return {
        type: "tool_call",
        tool: parsed.tool.trim(),
        args: args as Record<string, unknown>,
      };
    }
  }

  // Handle {tool: "name", args: {...}} without type field
  if (!typeValue && typeof parsed.tool === "string" && parsed.tool.trim() !== "") {
    const args = (parsed.args ?? parsed.params ?? parsed.input ?? parsed.arguments) as Record<string, unknown> | undefined;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return {
        type: "tool_call",
        tool: parsed.tool.trim(),
        args: args as Record<string, unknown>,
      };
    }
  }

  if (typeValue && typeValue.includes(".") && typeValue !== "final") {
    const { type: _type, ...rest } = parsed;
    const args = Object.keys(rest).length > 0 ? rest : undefined;
    if (args) {
      return {
        type: "tool_call",
        tool: typeValue,
        args,
      };
    }
  }

  if (typeValue === "final" && typeof parsed.content === "string") {
    return {
      type: "final",
      content: parsed.content,
    };
  }

  return undefined;
}

function extractStructuredJsonObjects(raw: string): string[] {
  let text = raw.trim();
  // Remove <think> blocks - handle both closed and unclosed tags
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  // If there's an unclosed <think>, remove everything from it onwards
  const unclosedThink = text.indexOf("<think>");
  if (unclosedThink >= 0) {
    text = text.slice(0, unclosedThink);
  }
  // Strip [TOOL_CALL] and [/TOOL_CALL] tags
  text = text.replace(/\[\/?TOOL_CALL\]/gi, "");
  // Strip [TOOL_RESPONSE] and similar tags
  text = text.replace(/\[\/?TOOL_RESPONSE\]/gi, "");
  text = text.trim();

  const fencedMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fencedMatch) {
    text = fencedMatch[1].trim();
  }

  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\" && inString) {
      escapeNext = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function tryRegexExtractToolCall(raw: string): AgentModelOutput | undefined {
  const jsonPattern = /\{[^{}]*"type"\s*:\s*"[^"]+"[^{}]*\}/g;
  let match: RegExpExecArray | null;

  while ((match = jsonPattern.exec(raw)) !== null) {
    try {
      const result = parseAgentOutputObject(match[0]);
      if (result && result.type === "tool_call") {
        return result;
      }
      if (result && result.type === "final") {
        return result;
      }
    } catch {
      // not valid JSON, continue
    }
  }

  const largerPattern = /\{[\s\S]*?"type"\s*:\s*"[^"]+"[\s\S]*?\}/g;
  while ((match = largerPattern.exec(raw)) !== null) {
    try {
      const result = parseAgentOutputObject(match[0]);
      if (result && result.type === "tool_call") {
        return result;
      }
    } catch {
      // not valid JSON, continue
    }
  }

  // Try pattern without type field: {tool: "name", args: {...}}
  const noTypePattern = /\{\s*"?tool"?\s*:\s*"[^"]+"\s*,\s*"?args"?\s*:\s*\{[\s\S]*?\}\s*\}/g;
  while ((match = noTypePattern.exec(raw)) !== null) {
    try {
      const result = parseAgentOutputObject(match[0]);
      if (result && result.type === "tool_call") {
        return result;
      }
    } catch {
      // not valid JSON, continue
    }
  }

  return undefined;
}

/**
 * 函数 `normalizeMemoryResults` 的职责说明。
 * `normalizeMemoryResults` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizeMemoryResults(value: unknown): MemorySearchResult[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const content = typeof candidate.content === "string" ? candidate.content : undefined;
    if (!content) {
      return [];
    }

    return [
      {
        id:
          typeof candidate.id === "string"
            ? candidate.id
            : `memory-${index + 1}`,
        content,
        score: typeof candidate.score === "number" ? candidate.score : undefined,
        source: typeof candidate.source === "string" ? candidate.source : undefined,
        metadata:
          candidate.metadata && typeof candidate.metadata === "object"
            ? (candidate.metadata as Record<string, unknown>)
            : undefined,
      } satisfies MemorySearchResult,
    ];
  });
}

/**
 * 函数 `mergeMemoryResults` 的职责说明。
 * `mergeMemoryResults` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function mergeMemoryResults(
  base: MemorySearchResult[],
  extra: MemorySearchResult[]
): MemorySearchResult[] {
  const merged = new Map<string, MemorySearchResult>();
  for (const item of [...base, ...extra]) {
    const key = item.id || item.content;
    if (!merged.has(key)) {
      merged.set(key, item);
    }
  }

  return [...merged.values()];
}

/**
 * 函数 `summarizeTools` 的职责说明。
 * `summarizeTools` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function summarizeTools(tools: ReturnType<ToolRegistry["list"]>) {
  return tools.map((tool) => ({
    name: tool.name,
    automationLevel: tool.policy?.automationLevel,
    riskLevel: tool.riskLevel,
    permissionLevel: tool.permissionLevel,
  }));
}

/**
 * 函数 `truncate` 的职责说明。
 * `truncate` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 16))}...[truncated]`;
}

/**
 * 函数 `throwIfAborted` 的职责说明。
 * `throwIfAborted` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("RUN_CANCELLED");
  }
}
