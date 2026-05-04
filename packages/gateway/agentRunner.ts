import { readTranscript } from "../session/src/transcript";
import type { ChatMessage, ModelProvider } from "../model/types";
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
import type { GatewayToolCallRecord } from "./toolCallTypes";
import type { ToolCallExecutor } from "./toolCallExecutor";
import type { ToolRegistry } from "./toolRegistry";
import { recordTranscript } from "./transcriptRecorder";
import type {
  GatewayDebugInfo,
  GatewayRequest,
  MemorySearchResult,
} from "./types";

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
}

interface AgentRunnerResult {
  text: string;
  memoryResults: MemorySearchResult[];
  toolCalls: GatewayToolCallRecord[];
  builtContext: ReturnType<ContextBuilder["buildContext"]>;
  autoToolLoop: GatewayDebugInfo["autoToolLoop"];
  devTask?: GatewayDebugInfo["devTask"];
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
  private devTaskTracker?: DevTaskTracker;

  constructor(options: AgentRunnerOptions) {
    this.modelProvider = options.modelProvider;
    this.memorySearch = options.memorySearch;
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder();
    this.toolRegistry = options.toolRegistry;
    this.toolCallExecutor = options.toolCallExecutor;
    this.auditLogger = options.auditLogger;
    this.maxToolCalls = options.maxToolCalls ?? 5;
    this.compressor = options.compressor ?? new ContextCompressor();
    this.devTaskMaxSteps = options.devTaskMaxSteps ?? 15;
    this.devTaskMaxFixRounds = options.devTaskMaxFixRounds ?? 3;
  }

  async run(request: GatewayRequest): Promise<AgentRunnerResult> {
    const devMode = isDevTask(request.input);
    const devTracker = devMode
      ? (this.restoreDevTaskTracker(request.sessionId) ?? createDevTaskTracker())
      : undefined;
    if (devMode && devTracker) {
      this.devTaskTracker = devTracker;
    }

    let memoryResults = await this.memorySearch(request.input);

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
          })
        ),
        memoryResults,
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
    const decisionTrace: NonNullable<
      GatewayDebugInfo["autoToolLoop"]
    >["decisionTrace"] = [];
    let lastTestFailed = false;

    for (let step = 0; step < this.maxToolCalls; step += 1) {
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
        await delay(backoffMs);
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
      });

      this.compressor.runPipeline(messagesForModel);

      const raw = await this.callModel(messagesForModel);
      this.compressor.updateTokenEstimate(Math.ceil(raw.length / 4));
      const parsed = tryParseAgentModelOutput(raw);
      if (!parsed) {
        decisionTrace.push({
          step: step + 1,
          action: "respond",
          reason: "model returned plain text",
        });
        return {
          text: raw,
          memoryResults,
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
        };
      }

      if (parsed.type === "final") {
        decisionTrace.push({
          step: step + 1,
          action: "respond",
          reason: "model returned final response",
          status: "completed",
        });
        return {
          text: parsed.content,
          memoryResults,
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
          devTask: devTracker ? this.buildDevTaskDebugInfo(devTracker, parsed.content) : undefined,
        };
      }

      const toolCallRequest = createGatewayToolCallRequest({
        toolName: parsed.tool,
        input: parsed.args,
        sessionId: request.sessionId,
        requestId: request.id,
        permissionMode: request.permissionMode,
        planState: request.planState,
        projectBoundary: request.projectBoundary,
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
      const toolCallRecord = await this.toolCallExecutor.execute(toolCallRequest);
      const toolDurationMs = Date.now() - toolStartTime;

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
    });

    const forcedFinalRaw = await this.callModel(finalMessages);
    const forcedFinal = tryParseAgentModelOutput(forcedFinalRaw);
    const finalText =
      forcedFinal && forcedFinal.type === "final"
        ? forcedFinal.content
        : forcedFinalRaw;

    return {
      text: finalText,
      memoryResults,
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
      devTask: devTracker ? this.buildDevTaskDebugInfo(devTracker, finalText) : undefined,
    };
  }

  private async callModel(messages: ChatMessage[]): Promise<string> {
    const result = await this.modelProvider.generate(messages);
    return result.text;
  }

  private buildTranscriptContext(
    sessionId: string | undefined,
    currentInput: string
  ): string | undefined {
    if (!sessionId) {
      return undefined;
    }

    const MAX_TRANSCRIPT_CHARS = 3000;
    const allEntries = readTranscript(sessionId)
      .filter((entry, index, entries) => {
        if (index !== entries.length - 1) {
          return true;
        }
        return !(entry.role === "user" && entry.content === currentInput);
      });

    if (allEntries.length === 0) {
      return undefined;
    }

    const selected: typeof allEntries = [];
    let usedChars = 0;
    for (let i = allEntries.length - 1; i >= 0; i--) {
      const entry = allEntries[i];
      const line = `${entry.role}: ${truncate(entry.content.replace(/\s+/g, " "), 240)}`;
      if (usedChars + line.length > MAX_TRANSCRIPT_CHARS && selected.length > 0) {
        break;
      }
      selected.unshift(entry);
      usedChars += line.length;
    }

    return selected
      .map((entry) => `${entry.role}: ${truncate(entry.content.replace(/\s+/g, " "), 240)}`)
      .join("\n");
  }

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
      id: `agent-runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  private persistDevTaskTracker(sessionId: string | undefined, tracker: DevTaskTracker): void {
    if (!sessionId) return;
    recordTranscript(sessionId, "system", "[dev_task_tracker]", {
      devTaskTracker: serializeDevTaskTracker(tracker),
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeBackoffMs(fixRounds: number): number {
  const base = 500;
  const max = 8000;
  return Math.min(base * Math.pow(2, fixRounds - 1), max);
}

function buildAgentMessages(input: {
  baseMessages: ChatMessage[];
  transcriptContext?: string;
  tools: ReturnType<ToolRegistry["list"]>;
  toolCalls: GatewayToolCallRecord[];
  forceFinal: boolean;
  maxToolCalls: number;
  devMode?: boolean;
  devTracker?: DevTaskTracker;
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
  if (input.transcriptContext) {
    supplemental.push({
      role: "system",
      content: `Recent session transcript:\n${input.transcriptContext}`,
    });
  }

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

  const systemContent = [
    "Agent Tool Loop v0.2 is enabled.",
    "You MUST respond with ONLY a single JSON object. No markdown fences, no explanation text, no thinking out loud.",
    "",
    input.forceFinal
      ? 'Return ONLY: {"type":"final","content":"your final answer here"}'
      : [
          "Return ONLY one of these two JSON objects (nothing else):",
          'To use a tool: {"type":"tool_call","tool":"tool_name","args":{"key":"value"}}',
          'To give final answer: {"type":"final","content":"your final answer"}',
          "",
          "IMPORTANT: Your ENTIRE response must be the JSON object. Do NOT include any text before or after it.",
        ].join("\n"),
    `Tool call budget: ${toolCallBudget}/${input.maxToolCalls}`,
    "",
    "Available tools:",
    JSON.stringify(
      input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        riskLevel: tool.riskLevel,
        permissionLevel: tool.permissionLevel,
        requiresSandbox: tool.requiresSandbox,
        schema: tool.schema ?? tool.inputSchema ?? {},
      })),
      null,
      2
    ),
    "",
    "Executed tool calls:",
    toolCallSummaryLines.length === 0
      ? "(none)"
      : toolCallSummaryLines.join("\n---\n"),
    "",
    "Use tools when needed for workspace files, shell commands, or memory.",
    "If the user asks to read a file, prefer file.read.",
    "If the user asks to run a command, prefer shell.run.",
    "For shell.run, set cwd to a Windows path such as D:\\WorkStation\\agent-rebuild.",
    "Do not use /workspace or POSIX-style paths. Always use Windows paths such as D:\\WorkStation\\agent-rebuild\\workspace.",
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
  return messages;
}

function tryParseAgentModelOutput(raw: string): AgentModelOutput | undefined {
  let text = raw.trim();

  const fencedMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fencedMatch) {
    text = fencedMatch[1].trim();
  }

  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    return undefined;
  }
  text = text.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const typeValue = typeof parsed.type === "string" ? parsed.type.trim() : "";
    const isToolCall = typeValue === "tool_call" || typeValue === "tool";

    if (isToolCall && typeof parsed.tool === "string" && parsed.tool.trim() !== "") {
      const args = (parsed.args ?? parsed.params ?? parsed.input ?? parsed.arguments) as Record<string, unknown> | undefined;
      if (args && typeof args === "object" && !Array.isArray(args)) {
        return {
          type: "tool_call",
          tool: parsed.tool.trim(),
          args: args as Record<string, unknown>,
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
  } catch {
    return undefined;
  }
}

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

function summarizeTools(tools: ReturnType<ToolRegistry["list"]>) {
  return tools.map((tool) => ({
    name: tool.name,
    automationLevel: tool.policy?.automationLevel,
    riskLevel: tool.riskLevel,
    permissionLevel: tool.permissionLevel,
  }));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 16))}...[truncated]`;
}
