
import * as crypto from "node:crypto";

import type { ChatMessage, ModelProvider } from "../../model/types";
import type { ToolCallExecutor } from "../toolCallExecutor";
import type { ToolRegistry } from "../toolRegistry";
import { createGatewayToolCallRequest } from "../toolCallFactory";
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
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parseModelOutput(raw: string): ParsedModelOutput | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
  }

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as ParsedModelOutput;
    if (parsed.type === "tool_call" && parsed.tool) {
      return { type: "tool_call", tool: parsed.tool, args: parsed.args ?? {} };
    }
    if (parsed.type === "final") {
      return { type: "final", content: parsed.content ?? cleaned };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 函数 `extractPayloadFromContent` 的职责说明。
 * `extractPayloadFromContent` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function extractPayloadFromContent(content: string): Record<string, unknown> {
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
  }

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  return { raw: content };
}

export class SubAgentRunner {
  private readonly modelProvider: ModelProvider;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolCallExecutor: ToolCallExecutor;
  private readonly workspaceRoot: string;
  private readonly auditLogger?: SubAgentRunnerOptions["auditLogger"];

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(options: SubAgentRunnerOptions) {
    this.modelProvider = options.modelProvider;
    this.toolRegistry = options.toolRegistry;
    this.toolCallExecutor = options.toolCallExecutor;
    this.workspaceRoot = options.workspaceRoot;
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

    try {
      const systemPrompt = this.buildSystemPrompt(agentDef, state, context);
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

      let finalContent = "";
      let step = 0;

      while (step < agentDef.maxToolCalls) {
        const response = await this.modelProvider.generate(messages);

        const rawOutput = response.text ?? "";

        const parsed = parseModelOutput(rawOutput);
        if (!parsed || parsed.type === "final") {
          finalContent = parsed?.content ?? rawOutput;
          break;
        }

        if (parsed.type === "tool_call" && parsed.tool) {
          const toolName = parsed.tool;
          const toolArgs = parsed.args ?? {};

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
          });

          if (!policyCheck.allowed) {
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
                error: `Policy denied: ${policyCheck.reason}`,
              }),
            });

            step++;
            continue;
          }

          const toolStartTime = Date.now();
          const toolRequest = createGatewayToolCallRequest({
            toolName,
            input: toolArgs,
            sessionId: state.runId,
            requestId: subRunId,
          });
          const toolResult = await this.toolCallExecutor.execute(toolRequest);
          const toolDuration = Date.now() - toolStartTime;

          const toolOk = toolResult.status === "success";
          const toolError = toolResult.error;
          const toolOutput = toolResult.output;

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
          });

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
      });

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
    context?: string
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
    parts.push(`Max Tool Calls: ${agentDef.maxToolCalls}`);

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
  private writeAudit(entry: Record<string, unknown>): void {
    if (!this.auditLogger) return;
    const write =
      this.auditLogger.log ??
      this.auditLogger.record ??
      this.auditLogger.append ??
      this.auditLogger.write;
    if (write) {
      try {
        write(entry);
      } catch {
        // best-effort
      }
    }
  }
}
