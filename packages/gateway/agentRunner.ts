import { readTranscript } from "../session/src/transcript";
import type { ChatMessage, ModelProvider } from "../model/types";
import { ContextBuilder } from "./contextBuilder";
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
}

interface AgentRunnerResult {
  text: string;
  memoryResults: MemorySearchResult[];
  toolCalls: GatewayToolCallRecord[];
  builtContext: ReturnType<ContextBuilder["buildContext"]>;
  autoToolLoop: GatewayDebugInfo["autoToolLoop"];
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

  constructor(options: AgentRunnerOptions) {
    this.modelProvider = options.modelProvider;
    this.memorySearch = options.memorySearch;
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder();
    this.toolRegistry = options.toolRegistry;
    this.toolCallExecutor = options.toolCallExecutor;
    this.auditLogger = options.auditLogger;
    this.maxToolCalls = options.maxToolCalls ?? 5;
  }

  async run(request: GatewayRequest): Promise<AgentRunnerResult> {
    let memoryResults = await this.memorySearch(request.input);
    const builtContext = this.contextBuilder.buildContext(request.input, memoryResults, {
      activeSkillNames: request.activeSkills,
      permissionMode: request.permissionMode,
      planState: request.planState,
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
      };
    }

    const toolCalls: GatewayToolCallRecord[] = [];
    const availableTools = this.toolRegistry.list();
    const decisionTrace: NonNullable<
      GatewayDebugInfo["autoToolLoop"]
    >["decisionTrace"] = [];

    for (let step = 0; step < this.maxToolCalls; step += 1) {
      const raw = await this.callModel(
        buildAgentMessages({
          baseMessages: builtContext.messages,
          transcriptContext,
          tools: availableTools,
          toolCalls,
          forceFinal: false,
          maxToolCalls: this.maxToolCalls,
        })
      );
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
        };
      }

      const toolCallRequest = createGatewayToolCallRequest({
        toolName: parsed.tool,
        input: parsed.args,
        sessionId: request.sessionId,
        requestId: request.id,
        permissionMode: request.permissionMode,
        planState: request.planState,
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

      const toolCallRecord = await this.toolCallExecutor.execute(toolCallRequest);
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
      });

      if (toolCallRecord.toolName === "memory.search" && toolCallRecord.result?.ok) {
        const extraMemory = normalizeMemoryResults(toolCallRecord.result.result);
        memoryResults = mergeMemoryResults(memoryResults, extraMemory);
      }
    }

    const forcedFinalRaw = await this.callModel(
      buildAgentMessages({
        baseMessages: builtContext.messages,
        transcriptContext,
        tools: availableTools,
        toolCalls,
        forceFinal: true,
        maxToolCalls: this.maxToolCalls,
      })
    );
    const forcedFinal = tryParseAgentModelOutput(forcedFinalRaw);

    return {
      text:
        forcedFinal && forcedFinal.type === "final"
          ? forcedFinal.content
          : forcedFinalRaw,
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

    const entries = readTranscript(sessionId)
      .slice(-12)
      .filter((entry, index, all) => {
        if (index !== all.length - 1) {
          return true;
        }

        return !(entry.role === "user" && entry.content === currentInput);
      });

    if (entries.length === 0) {
      return undefined;
    }

    return entries
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
}

function buildAgentMessages(input: {
  baseMessages: ChatMessage[];
  transcriptContext?: string;
  tools: ReturnType<ToolRegistry["list"]>;
  toolCalls: GatewayToolCallRecord[];
  forceFinal: boolean;
  maxToolCalls: number;
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

  supplemental.push({
    role: "system",
    content: [
      "Agent Tool Loop v0.2 is enabled.",
      "You must respond with strict JSON only and no markdown.",
      "",
      input.forceFinal
        ? 'Return only {"type":"final","content":"..."} now.'
        : 'Return either {"type":"tool_call","tool":"...","args":{...}} or {"type":"final","content":"..."}',
      `Tool call budget: ${Math.max(0, input.maxToolCalls - input.toolCalls.length)}/${input.maxToolCalls}`,
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
      input.toolCalls.length === 0
        ? "[]"
        : JSON.stringify(
            input.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.toolName,
              riskLevel: toolCall.riskLevel,
              permissionLevel: toolCall.permissionLevel,
              status: toolCall.status,
              error: toolCall.error,
              result: toolCall.result?.result ?? toolCall.output?.content,
            })),
            null,
            2
          ),
      "",
      "Use tools when needed for workspace files, shell commands, or memory.",
      "If the user asks to read a file, prefer file.read.",
      "If the user asks to run a command, prefer shell.run.",
      "For shell.run, set cwd to a Windows path such as D:\\WorkStation\\agent-rebuild.",
      "Do not use /workspace or POSIX-style paths. Always use Windows paths such as D:\\WorkStation\\agent-rebuild\\workspace.",
    ].join("\n"),
  });

  messages.splice(insertionIndex, 0, ...supplemental);
  return messages;
}

function tryParseAgentModelOutput(raw: string): AgentModelOutput | undefined {
  const text = raw.trim();
  if (!text.startsWith("{")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (
      parsed.type === "tool_call" &&
      typeof parsed.tool === "string" &&
      parsed.tool.trim() !== "" &&
      parsed.args &&
      typeof parsed.args === "object" &&
      !Array.isArray(parsed.args)
    ) {
      return {
        type: "tool_call",
        tool: parsed.tool.trim(),
        args: parsed.args as Record<string, unknown>,
      };
    }

    if (parsed.type === "final" && typeof parsed.content === "string") {
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
