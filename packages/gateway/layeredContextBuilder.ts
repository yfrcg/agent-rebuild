/**
 * ?????CS336 ???
 * ???packages/gateway/layeredContextBuilder.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import type { ChatMessage } from "../model/types";
import type { GatewayProjectBoundary } from "./toolCallTypes";
import type { MemorySearchResult } from "./types";
import { allocateTokenBudget, getLayerBudget } from "./tokenBudgetAllocator";
import { estimateTokensFromText } from "./contextCompressor";

export interface LayeredContextInput {
  sessionId?: string;
  userInput: string;
  projectBoundary?: GatewayProjectBoundary;
  memoryResults?: MemorySearchResult[];
  transcriptContext?: ChatMessage[];
  toolResults?: ChatMessage[];
  systemPrompt: string;
  totalTokenBudget: number;
}

export interface LayeredContextOutput {
  messages: ChatMessage[];
  layerUsage: Record<string, number>;
  totalTokens: number;
  budgetExceeded: boolean;
}

export function buildLayeredContext(input: LayeredContextInput): LayeredContextOutput {
  const allocation = allocateTokenBudget(input.totalTokenBudget);
  const layerUsage: Record<string, number> = {};
  const messages: ChatMessage[] = [];
  let totalTokens = 0;

  const systemBudget = getLayerBudget(allocation, "system");
  const systemTokens = estimateTokensFromText(input.systemPrompt);
  if (systemTokens <= systemBudget) {
    messages.push({ role: "system", content: input.systemPrompt });
    layerUsage.system = systemTokens;
    totalTokens += systemTokens;
  } else {
    const truncated = input.systemPrompt.slice(0, systemBudget * 3);
    messages.push({ role: "system", content: truncated });
    layerUsage.system = systemBudget;
    totalTokens += systemBudget;
  }

  const projectBudget = getLayerBudget(allocation, "project_context");
  if (input.projectBoundary?.projectDir) {
    const projectMsg = buildProjectMessage(input.projectBoundary);
    const projectTokens = estimateTokensFromText(projectMsg);
    if (projectTokens <= projectBudget) {
      messages.push({ role: "system", content: projectMsg });
      layerUsage.project_context = projectTokens;
      totalTokens += projectTokens;
    }
  }

  const memoryBudget = getLayerBudget(allocation, "memory");
  if (input.memoryResults && input.memoryResults.length > 0) {
    const memoryMsg = buildMemoryMessage(input.memoryResults);
    const memoryTokens = estimateTokensFromText(memoryMsg);
    if (memoryTokens <= memoryBudget) {
      messages.push({ role: "system", content: memoryMsg });
      layerUsage.memory = memoryTokens;
      totalTokens += memoryTokens;
    } else {
      const truncated = memoryMsg.slice(0, memoryBudget * 3);
      messages.push({ role: "system", content: truncated });
      layerUsage.memory = memoryBudget;
      totalTokens += memoryBudget;
    }
  }

  const transcriptBudget = getLayerBudget(allocation, "transcript");
  if (input.transcriptContext && input.transcriptContext.length > 0) {
    let transcriptTokens = 0;
    const transcriptMsgs: ChatMessage[] = [];

    for (const msg of input.transcriptContext) {
      const msgTokens = estimateTokensFromText(msg.content);
      if (transcriptTokens + msgTokens > transcriptBudget) break;
      transcriptMsgs.push(msg);
      transcriptTokens += msgTokens;
    }

    if (transcriptMsgs.length > 0) {
      const lastSystemIdx = messages.reduce((acc, m, i) => m.role === "system" ? i : acc, -1);
      const insertAt = lastSystemIdx >= 0 ? lastSystemIdx + 1 : 0;
      messages.splice(insertAt, 0, ...transcriptMsgs);
      layerUsage.transcript = transcriptTokens;
      totalTokens += transcriptTokens;
    }
  }

  const currentBudget = getLayerBudget(allocation, "current_input");
  const currentTokens = estimateTokensFromText(input.userInput);
  messages.push({ role: "user", content: input.userInput });
  layerUsage.current_input = Math.min(currentTokens, currentBudget);
  totalTokens += currentTokens;

  const toolBudget = getLayerBudget(allocation, "tool_results");
  if (input.toolResults && input.toolResults.length > 0) {
    let toolTokens = 0;
    for (const msg of input.toolResults) {
      const msgTokens = estimateTokensFromText(msg.content);
      if (toolTokens + msgTokens > toolBudget) break;
      messages.push(msg);
      toolTokens += msgTokens;
    }
    layerUsage.tool_results = toolTokens;
    totalTokens += toolTokens;
  }

  return {
    messages,
    layerUsage,
    totalTokens,
    budgetExceeded: totalTokens > input.totalTokenBudget,
  };
}

function buildProjectMessage(boundary: GatewayProjectBoundary): string {
  const parts = [
    `[Project Context]`,
    `Project: ${boundary.projectDir}`,
    `Permission: ${boundary.permission}`,
  ];
  if (boundary.commandCwd) parts.push(`CWD: ${boundary.commandCwd}`);
  return parts.join("\n");
}

function buildMemoryMessage(results: MemorySearchResult[]): string {
  const parts = ["[Relevant Memory]"];
  for (const result of results.slice(0, 5)) {
    const score = result.score != null ? result.score.toFixed(2) : "n/a";
    parts.push(`- ${result.content.slice(0, 100)} (score: ${score})`);
  }
  return parts.join("\n");
}
