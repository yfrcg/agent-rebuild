
import * as crypto from "node:crypto";

import type { ChatMessage, ModelProvider } from "../../model/types";
import type { ToolCallExecutor } from "../toolCallExecutor";
import type { ToolRegistry } from "../toolRegistry";
import { createGatewayToolCallRequest } from "../toolCallFactory";
import { extractBalancedJson, tryParseWithFix } from "../textSanitizer";
import type {
  AgentDefinition,
  AgentResult,
  GraphNode,
  ReviewGraphState,
  ToolCallRecord,
  ToolPolicyCheck,
} from "./types";
import { checkToolPolicy } from "./toolPolicy";

export interface SubAgentRunnerOptions {
  modelProvider: ModelProvider;
  toolRegistry: ToolRegistry;
  toolCallExecutor: ToolCallExecutor;
  workspaceRoot: string;
  maxToolCallsPerAgent?: number;
  auditLogger?: {
    log?: (entry: Record<string, unknown>) => void;
    record?: (entry: Record<string, unknown>) => void;
    append?: (entry: Record<string, unknown>) => void;
    write?: (entry: Record<string, unknown>) => void;
  };
}

export interface SubAgentRunInput {
  agentDef: AgentDefinition;
  userPrompt: string;
  context?: string;
  state: ReviewGraphState;
}

interface ParsedModelOutput {
  type: "tool_call" | "final";
  tool?: string;
  args?: Record<string, unknown>;
  content?: string;
}

/**
 * 函数 `generateSubRunId` 的职责说明。
 * `generateSubRunId` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function generateSubRunId(): string {
  return `sub_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * 函数 `parseModelOutput` 的职责说明。
 * `parseModelOutput` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * Uses extractBalancedJson for robust JSON extraction from markdown/text.
 */
function parseModelOutput(raw: string): ParsedModelOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip markdown code fences
  let cleaned = trimmed;
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
  }

  // Use balanced JSON extraction (handles nested braces, strings, markdown wrappers)
  const jsonBlock = extractBalancedJson(cleaned);
  const textToParse = jsonBlock ?? cleaned;

  // Try direct parse first
  const parsed = tryParseWithFix(textToParse);
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    if (p.type === "tool_call" && typeof p.tool === "string" && p.tool) {
      return { type: "tool_call", tool: p.tool, args: (p.args as Record<string, unknown>) ?? {} };
    }
    if (p.type === "final") {
      return { type: "final", content: typeof p.content === "string" ? p.content : JSON.stringify(p) };
    }
    // Has a tool field but no type — treat as tool_call
    if (typeof p.tool === "string" && p.tool) {
      const args = (p.args ?? p.params ?? p.input ?? p.arguments) as Record<string, unknown> | undefined;
      return { type: "tool_call", tool: p.tool, args: args ?? {} };
    }
    // Has content/text/message — treat as final
    const content = extractMeaningfulContent(p);
    if (content) return { type: "final", content };
  }

  // No parseable JSON — treat the raw text as a final response
  // (model may have responded with plain text instead of JSON)
  if (trimmed.length > 0) {
    return { type: "final", content: trimmed };
  }

  return null;
}

function extractMeaningfulContent(obj: Record<string, unknown>): string | undefined {
  const priorityKeys = ["content", "text", "message", "response", "answer", "result", "output"];
  for (const key of priorityKeys) {
    if (typeof obj[key] === "string" && obj[key].trim()) return obj[key].trim();
  }
  let longest = "";
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && value.length > longest.length && !value.startsWith("{")) {
      longest = value;
    }
  }
  return longest || undefined;
}

/**
 * 函数 `extractPayloadFromContent` 的职责说明。
 * `extractPayloadFromContent` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * Uses extractBalancedJson + tryParseWithFix for robust extraction.
 */
function extractPayloadFromContent(content: string): Record<string, unknown> {
  if (!content || !content.trim()) {
    return { summary: "" };
  }

  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
  }

  // Try balanced JSON extraction first
  const jsonBlock = extractBalancedJson(cleaned);
  if (jsonBlock) {
    const parsed = tryParseWithFix(jsonBlock);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  // Try parsing the whole cleaned string
  const directParsed = tryParseWithFix(cleaned);
  if (directParsed && typeof directParsed === "object" && !Array.isArray(directParsed)) {
    return directParsed as Record<string, unknown>;
  }

  // Fall back to text summary
  const summary = cleaned.length > 500 ? cleaned.slice(0, 500) : cleaned;
  return { summary, raw: content };
}

export class SubAgentRunner {
  private readonly modelProvider: ModelProvider;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolCallExecutor: ToolCallExecutor;
  private readonly workspaceRoot: string;
  private readonly maxToolCallsPerAgent?: number;
  private readonly auditLogger?: SubAgentRunnerOptions["auditLogger"];

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(options: SubAgentRunnerOptions) {
    this.modelProvider = options.modelProvider;
    this.toolRegistry = options.toolRegistry;
    this.toolCallExecutor = options.toolCallExecutor;
    this.workspaceRoot = options.workspaceRoot;
    this.maxToolCallsPerAgent = options.maxToolCallsPerAgent;
    this.auditLogger = options.auditLogger;
  }

  /**
   * 方法 `run` 的职责说明。
   * `run` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  async run(input: SubAgentRunInput): Promise<AgentResult> {
    const startTime = Date.now();
    const subRunId = generateSubRunId();
    const { agentDef, userPrompt, context, state } = input;
    const toolCalls: ToolCallRecord[] = [];
    const auditRefs: string[] = [];
    const effectiveMaxToolCalls = this.maxToolCallsPerAgent ?? agentDef.maxToolCalls;

    try {
      const systemPrompt = this.buildSystemPrompt(agentDef, state, context, effectiveMaxToolCalls);
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

      let finalContent = "";
      let step = 0;
      let consecutiveDenials = 0;
      const MAX_CONSECUTIVE_DENIALS = 3;
      const lastRawOutputs: string[] = [];

      while (step < effectiveMaxToolCalls) {
        const response = await this.modelProvider.generate(messages);

        const rawOutput = response.text ?? "";
        lastRawOutputs.push(rawOutput);

        const parsed = parseModelOutput(rawOutput);
        console.error(`[SubAgent:${agentDef.name}] step=${step} parsed.type=${parsed?.type} parsed.tool=${parsed?.tool} rawOutput.len=${rawOutput.length}`);
        if (!parsed || parsed.type === "final") {
          finalContent = parsed?.content ?? rawOutput;
          break;
        }

        if (parsed.type === "tool_call" && parsed.tool) {
          const toolName = parsed.tool;
          const toolArgs = parsed.args ?? {};
          console.error(`[SubAgent:${agentDef.name}] tool_call: ${toolName} args=${JSON.stringify(toolArgs).slice(0, 200)}`);

          const policyCheck: ToolPolicyCheck = checkToolPolicy({
            agentDef,
            toolName,
            args: toolArgs,
            state,
            workspaceRoot: this.workspaceRoot,
          });

          this.writeAudit({
            runId: state.runId,
            subRunId,
            agentName: agentDef.name,
            node: agentDef.node,
            toolName,
            argsPreview: JSON.stringify(toolArgs).slice(0, 200),
            policyDecision: policyCheck.allowed ? "allow" : "deny",
            status: policyCheck.allowed ? "pending" : "blocked",
            timestamp: Date.now(),
          }, auditRefs);

          if (!policyCheck.allowed) {
            consecutiveDenials++;
            console.error(`[SubAgent:${agentDef.name}] POLICY DENIED: ${toolName} reason=${policyCheck.reason} consecutiveDenials=${consecutiveDenials}`);
            toolCalls.push({
              toolName,
              args: toolArgs,
              result: {
                ok: false,
                error: `Policy denied: ${policyCheck.reason}. Violations: ${policyCheck.violations.join(", ")}`,
              },
              durationMs: 0,
              policyDecision: "deny",
              timestamp: Date.now(),
            });

            // Build a helpful denial message that lists available tools
            const availableToolNames = agentDef.allowedTools.filter(
              (t) => !agentDef.deniedTools.includes(t)
            );
            let denialMsg = `Tool "${toolName}" is not available. ${policyCheck.reason}.`;
            denialMsg += `\nAvailable tools: ${availableToolNames.join(", ")}`;

            // If too many consecutive denials, force the model to produce a final response
            if (consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
              denialMsg += `\n\nYou have made ${consecutiveDenials} invalid tool calls in a row. You MUST now respond with your final output in this format:`;
              denialMsg += `\n{"type": "final", "content": "your JSON structured output here"}`;
              denialMsg += `\nDo NOT attempt any more tool calls. Use the information you already gathered.`;
            }

            messages.push({
              role: "assistant",
              content: JSON.stringify({ type: "tool_call", tool: toolName, args: toolArgs }),
            });
            messages.push({
              role: "user",
              content: JSON.stringify({
                type: "tool_result",
                tool: toolName,
                ok: false,
                error: denialMsg,
              }),
            });

            step++;
            continue;
          }

          // Reset consecutive denials on successful tool call
          consecutiveDenials = 0;

          const toolStartTime = Date.now();
          const toolRequest = createGatewayToolCallRequest({
            toolName,
            input: toolArgs,
            sessionId: state.runId,
            requestId: subRunId,
            approved: true,
          });
          const toolResult = await this.toolCallExecutor.execute(toolRequest);
          const toolDuration = Date.now() - toolStartTime;

          const toolOk = toolResult.status === "success";
          const toolError = toolResult.error;
          const toolOutput = toolResult.output;
          console.error(`[SubAgent:${agentDef.name}] tool_result: ${toolName} ok=${toolOk} error=${toolError} duration=${toolDuration}ms`);

          toolCalls.push({
            toolName,
            args: toolArgs,
            result: {
              ok: toolOk,
              content: toolOutput,
              error: toolError,
            },
            durationMs: toolDuration,
            policyDecision: "allow",
            timestamp: Date.now(),
          });

          this.writeAudit({
            runId: state.runId,
            subRunId,
            agentName: agentDef.name,
            node: agentDef.node,
            toolName,
            argsPreview: JSON.stringify(toolArgs).slice(0, 200),
            policyDecision: "allow",
            status: toolOk ? "success" : "error",
            durationMs: toolDuration,
            timestamp: Date.now(),
          }, auditRefs);

          messages.push({
            role: "assistant",
            content: JSON.stringify({ type: "tool_call", tool: toolName, args: toolArgs }),
          });
          messages.push({
            role: "user",
            content: JSON.stringify({
              type: "tool_result",
              tool: toolName,
              ok: toolOk,
              content: toolOutput,
              error: toolError,
            }),
          });
        }

        step++;
      }

      // If loop exhausted without a final response, try to salvage from last outputs
      if (!finalContent && lastRawOutputs.length > 0) {
        for (let i = lastRawOutputs.length - 1; i >= 0; i--) {
          const lastOutput = lastRawOutputs[i];
          if (lastOutput && lastOutput.trim()) {
            finalContent = lastOutput.trim();
            break;
          }
        }
      }

      // If still empty, produce a minimal summary from tool call results
      if (!finalContent) {
        const successfulCalls = toolCalls.filter((tc) => tc.result?.ok);
        if (successfulCalls.length > 0) {
          finalContent = JSON.stringify({
            summary: `Completed ${successfulCalls.length} tool calls for ${agentDef.node} phase`,
            toolResults: successfulCalls.map((tc) => ({
              tool: tc.toolName,
              result: tc.result?.content,
            })),
          });
        } else {
          finalContent = JSON.stringify({
            summary: `${agentDef.node} agent exhausted all tool calls without producing a result`,
            toolCallCount: toolCalls.length,
          });
        }
      }

      const durationMs = Date.now() - startTime;
      const payload = extractPayloadFromContent(finalContent);

      return {
        subRunId,
        agentName: agentDef.name,
        node: agentDef.node as GraphNode,
        status: "ok",
        summary: finalContent.slice(0, 500),
        payload,
        durationMs,
        toolCalls,
        auditRefs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.writeAudit({
        runId: state.runId,
        subRunId,
        agentName: agentDef.name,
        node: agentDef.node,
        toolName: "agent.run",
        policyDecision: "allow",
        status: "error",
        error: errorMessage,
        durationMs,
        timestamp: Date.now(),
      }, auditRefs);

      return {
        subRunId,
        agentName: agentDef.name,
        node: agentDef.node as GraphNode,
        status: "error",
        summary: `Agent execution failed: ${errorMessage}`,
        payload: { error: errorMessage },
        durationMs,
        toolCalls,
        auditRefs,
        error: errorMessage,
      };
    }
  }

  /**
   * 方法 `buildSystemPrompt` 的职责说明。
   * `buildSystemPrompt` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private buildSystemPrompt(
    agentDef: AgentDefinition,
    state: ReviewGraphState,
    context?: string,
    maxToolCalls?: number
  ): string {
    const parts: string[] = [agentDef.systemPrompt];

    parts.push(`\n## Current Task Context`);
    parts.push(`User Goal: ${state.userGoal}`);
    parts.push(`Task Type: ${state.taskType}`);
    parts.push(`Current Node: ${state.currentNode}`);

    if (state.targetFiles && state.targetFiles.length > 0) {
      parts.push(`\nTarget Files:\n${state.targetFiles.map((f) => `- ${f}`).join("\n")}`);
    }

    if (state.constraints && state.constraints.length > 0) {
      parts.push(`\nConstraints:\n${state.constraints.map((c) => `- ${c}`).join("\n")}`);
    }

    parts.push(`\n## Tool Policy`);
    parts.push(`Allowed Tools: ${agentDef.allowedTools.join(", ")}`);
    if (agentDef.deniedTools.length > 0) {
      parts.push(`Denied Tools: ${agentDef.deniedTools.join(", ")}`);
    }
    parts.push(`Can Spawn Agents: ${agentDef.canSpawnAgents}`);
    parts.push(`Max Tool Calls: ${maxToolCalls ?? agentDef.maxToolCalls}`);

    const availableTools = this.toolRegistry
      .list()
      .filter((t) => agentDef.allowedTools.includes(t.name));
    if (availableTools.length > 0) {
      parts.push(`\n## Available Tools (detailed)`);
      for (const tool of availableTools) {
        const schema = tool.schema as Record<string, unknown> | undefined;
        const props = schema?.properties as Record<string, unknown> | undefined;
        const required = schema?.required as string[] | undefined;
        let paramDesc = "";
        if (props) {
          const paramEntries = Object.entries(props).map(([key, val]) => {
            const type = (val as Record<string, unknown>)?.type ?? "unknown";
            const isReq = required?.includes(key) ? " (required)" : " (optional)";
            return `  - ${key}: ${type}${isReq}`;
          });
          paramDesc = `\nParameters:\n${paramEntries.join("\n")}`;
        }
        parts.push(`\n### ${tool.name}\n${tool.description ?? "No description"}${paramDesc}`);
      }
    }

    if (context) {
      parts.push(`\n## Additional Context\n${context}`);
    }

    parts.push(`\n## Output Format`);
    parts.push(`When you need to use a tool, respond with JSON:`);
    parts.push(`{"type": "tool_call", "tool": "tool_name", "args": {...}}`);
    parts.push(`When you are done, respond with JSON:`);
    parts.push(`{"type": "final", "content": "your structured output as JSON"}`);

    return parts.join("\n");
  }

  /**
   * 方法 `writeAudit` 的职责说明。
   * `writeAudit` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private writeAudit(entry: Record<string, unknown>, auditRefs?: string[]): void {
    if (!this.auditLogger) return;
    const refId = crypto.randomUUID();
    const write =
      this.auditLogger.log ??
      this.auditLogger.record ??
      this.auditLogger.append ??
      this.auditLogger.write;
    if (write) {
      try {
        write({ ...entry, refId });
      } catch {
        // best-effort
      }
    }
    if (auditRefs) {
      auditRefs.push(refId);
    }
  }
}
