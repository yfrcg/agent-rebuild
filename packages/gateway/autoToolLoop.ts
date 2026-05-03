import type { ChatMessage } from "../model/types";
import type { GatewayToolCallRecord } from "./toolCallTypes";
import type { GatewayToolListItem } from "./toolTypes";
import type { MemorySearchResult } from "./types";

export interface AutoToolDecisionRespond {
  action: "respond";
  reason?: string;
}

export interface AutoToolDecisionTool {
  action: "tool";
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
}

export type AutoToolDecision = AutoToolDecisionRespond | AutoToolDecisionTool;

export function buildAutoToolDecisionMessages(input: {
  baseMessages: ChatMessage[];
  tools: GatewayToolListItem[];
  toolCalls: GatewayToolCallRecord[];
  maxSteps: number;
}): ChatMessage[] {
  const remainingSteps = Math.max(0, input.maxSteps - input.toolCalls.length);
  const toolInventory = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? {},
  }));

  const toolCallSummary =
    input.toolCalls.length === 0
      ? "none"
      : input.toolCalls
          .map((record, index) => {
            const contentPreview = safeJsonPreview(record.output?.content);
            return [
              `#${index + 1}`,
              `tool=${record.toolName}`,
              `status=${record.status}`,
              `error=${record.error ?? "none"}`,
              `content=${contentPreview}`,
            ].join(" | ");
          })
          .join("\n");

  return [
    ...input.baseMessages,
    {
      role: "user",
      content: [
        "[AUTO_TOOL_DECISION]",
        "Decide whether the Gateway should call one tool before answering.",
        "Return strict JSON only. Do not use markdown or code fences.",
        "",
        `Remaining tool budget: ${remainingSteps}`,
        "",
        "Allowed tools:",
        JSON.stringify(toolInventory, null, 2),
        "",
        "Executed tool calls so far:",
        toolCallSummary,
        "",
        "Rules:",
        '1. If a listed tool would materially improve the answer, return {"action":"tool","toolName":"...","input":{...},"reason":"..."}.',
        '2. If tools are unnecessary or the current information is enough, return {"action":"respond","reason":"..."}.',
        "3. Use at most one tool in this decision.",
        "4. Never invent tool names or omit required input fields if a tool is selected.",
        "5. Prefer `memory.search` for local workspace facts before using external MCP tools.",
      ].join("\n"),
    },
  ];
}

export function buildAutoToolAnswerMessages(input: {
  baseMessages: ChatMessage[];
  toolCalls: GatewayToolCallRecord[];
}): ChatMessage[] {
  if (input.toolCalls.length === 0) {
    return input.baseMessages;
  }

  const summary = input.toolCalls
    .map((record, index) => {
      const contentPreview = safeJsonPreview(record.output?.content, 1200);
      return [
        `[Tool Call ${index + 1}]`,
        `tool: ${record.toolName}`,
        `status: ${record.status}`,
        `error: ${record.error ?? "none"}`,
        "output:",
        contentPreview,
      ].join("\n");
    })
    .join("\n\n");

  return [
    ...input.baseMessages,
    {
      role: "user",
      content: [
        "[AUTO_TOOL_RESULTS]",
        "Additional tool execution context is available below.",
        "Use successful results when they help answer the user.",
        "If a tool failed, mention that only when it materially affects the answer.",
        "Answer in normal prose. Do not output JSON.",
        "",
        summary,
      ].join("\n"),
    },
  ];
}

export function parseAutoToolDecision(raw: string): AutoToolDecision {
  const text = extractJsonObject(raw);
  const parsed = JSON.parse(text) as Record<string, unknown>;

  if (parsed.action === "respond") {
    return {
      action: "respond",
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  }

  if (
    parsed.action === "tool" &&
    typeof parsed.toolName === "string" &&
    parsed.toolName.trim() !== "" &&
    parsed.input &&
    typeof parsed.input === "object" &&
    !Array.isArray(parsed.input)
  ) {
    return {
      action: "tool",
      toolName: parsed.toolName.trim(),
      input: parsed.input as Record<string, unknown>,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  }

  throw new Error("Auto tool decision JSON has unsupported schema.");
}

export function normalizeMemorySearchResults(content: unknown): MemorySearchResult[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const normalized: Array<MemorySearchResult | undefined> = content.map((item, index) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }

      const value = item as Record<string, unknown>;
      const metadata = asRecord(value.metadata);
      const id =
        typeof value.id === "string"
          ? value.id
          : typeof value.chunkId === "string"
            ? value.chunkId
            : `memory-${index + 1}`;
      const contentText =
        typeof value.content === "string"
          ? value.content
          : typeof value.text === "string"
            ? value.text
            : undefined;

      if (!contentText) {
        return undefined;
      }

      return {
        id,
        content: contentText,
        score: typeof value.score === "number" ? value.score : undefined,
        source:
          typeof value.source === "string"
            ? value.source
            : typeof value.filePath === "string"
              ? value.filePath
              : undefined,
        metadata: {
          ...metadata,
          ...(typeof value.section === "string" ? { section: value.section } : {}),
          ...(typeof value.filePath === "string" ? { filePath: value.filePath } : {}),
          ...(typeof value.date === "string" ? { date: value.date } : {}),
        },
      } satisfies MemorySearchResult;
    });

  return normalized.filter((item): item is MemorySearchResult => item !== undefined);
}

export function mergeMemoryResults(
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

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    const insideFence = fenceMatch[1].trim();
    if (insideFence.startsWith("{") && insideFence.endsWith("}")) {
      return insideFence;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error("Auto tool decision is not valid JSON.");
}

function safeJsonPreview(value: unknown, maxChars = 600): string {
  const raw =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2);
          } catch {
            return String(value);
          }
        })();

  if (raw.length <= maxChars) {
    return raw;
  }

  return `${raw.slice(0, maxChars)}...[truncated]`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}
