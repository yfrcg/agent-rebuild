/**
 * ?????CS336 ???
 * ???packages/gateway/autoToolLoop.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import type { ChatMessage, ModelProvider } from "../model/types";
import type { ContextCompressor } from "./contextCompressor";
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

/**
 * 函数 `buildAutoToolDecisionMessages` 的职责说明。
 * `buildAutoToolDecisionMessages` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
        "6. Use `bash.run` only when the user explicitly asks to run a shell command such as `node -v`, `npm test`, or `npm run build`.",
      ].join("\n"),
    },
  ];
}

/**
 * 函数 `buildAutoToolAnswerMessages` 的职责说明。
 * `buildAutoToolAnswerMessages` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

/**
 * 函数 `parseAutoToolDecision` 的职责说明。
 * `parseAutoToolDecision` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

/**
 * 函数 `normalizeMemorySearchResults` 的职责说明。
 * `normalizeMemorySearchResults` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

/**
 * 函数 `mergeMemoryResults` 的职责说明。
 * `mergeMemoryResults` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

/**
 * 函数 `extractJsonObject` 的职责说明。
 * `extractJsonObject` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

/**
 * 函数 `safeJsonPreview` 的职责说明。
 * `safeJsonPreview` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

/**
 * 函数 `asRecord` 的职责说明。
 * `asRecord` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

const DEV_TASK_KEYWORDS = [
  "fix", "bug", "test", "typecheck", "build", "implement", "feature",
  "modify", "change", "update", "create", "write", "refactor", "debug",
  "npm test", "npm run", "pnpm test", "pnpm run", "修复", "测试", "实现",
  "修改", "重构", "调试", "构建",
];

/**
 * 函数 `isDevTask` 的职责说明。
 * `isDevTask` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function isDevTask(input: string): boolean {
  const lower = input.toLowerCase();
  return DEV_TASK_KEYWORDS.some((kw) => lower.includes(kw));
}

export interface StructuredToolResult {
  toolName: string;
  status: "ok" | "error";
  durationMs?: number;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  timedOut?: boolean;
  fullOutputPath?: string;
  error?: string;
  rawContent: string;
}

/**
 * 函数 `extractStructuredResult` 的职责说明。
 * `extractStructuredResult` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function extractStructuredResult(
  toolName: string,
  result: { content: string; isError?: boolean },
  durationMs?: number
): StructuredToolResult {
  const base: StructuredToolResult = {
    toolName,
    status: result.isError ? "error" : "ok",
    durationMs,
    rawContent: result.content,
  };

  try {
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    if (typeof parsed.exitCode === "number") {
      base.exitCode = parsed.exitCode;
    }
    if (typeof parsed.stdout === "string") {
      base.stdoutPreview = parsed.stdout.slice(0, 2000);
    }
    if (typeof parsed.stderr === "string") {
      base.stderrPreview = parsed.stderr.slice(0, 1000);
    }
    if (typeof parsed.timedOut === "boolean") {
      base.timedOut = parsed.timedOut;
    }
    if (typeof parsed.fullOutputPath === "string") {
      base.fullOutputPath = parsed.fullOutputPath;
    }
  } catch {
    // not JSON — use raw content as-is
  }

  return base;
}

/**
 * 函数 `formatStructuredResultForContext` 的职责说明。
 * `formatStructuredResultForContext` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function formatStructuredResultForContext(result: StructuredToolResult): string {
  const lines: string[] = [`[Tool Result] tool=${result.toolName} status=${result.status}`];

  if (result.exitCode !== undefined) {
    lines.push(`exitCode=${result.exitCode}`);
  }
  if (result.durationMs !== undefined) {
    lines.push(`durationMs=${result.durationMs}`);
  }
  if (result.timedOut) {
    lines.push("timedOut=true");
  }
  if (result.error) {
    lines.push(`error: ${result.error.slice(0, 500)}`);
  }
  if (result.stdoutPreview) {
    lines.push(`stdout:\n${result.stdoutPreview}`);
  }
  if (result.stderrPreview) {
    lines.push(`stderr:\n${result.stderrPreview}`);
  }
  if (result.fullOutputPath) {
    lines.push(`fullOutput: ${result.fullOutputPath}`);
  }

  return lines.join("\n");
}

export interface DevTaskTracker {
  filesModified: Set<string>;
  commandsRun: Array<{ toolName: string; input: Record<string, unknown>; exitCode?: number }>;
  testResults: Array<{ command: string; passed: boolean; summary: string }>;
  fixRounds: number;
}

/**
 * 函数 `createDevTaskTracker` 的职责说明。
 * `createDevTaskTracker` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createDevTaskTracker(): DevTaskTracker {
  return {
    filesModified: new Set(),
    commandsRun: [],
    testResults: [],
    fixRounds: 0,
  };
}

/**
 * 函数 `trackToolCall` 的职责说明。
 * `trackToolCall` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function trackToolCall(
  tracker: DevTaskTracker,
  toolName: string,
  input: Record<string, unknown>,
  structuredResult: StructuredToolResult
): void {
  if (toolName === "file.edit" || toolName === "file.write") {
    const filePath = typeof input.path === "string" ? input.path : undefined;
    if (filePath) tracker.filesModified.add(filePath);
  }

  if (toolName === "bash.run" || toolName === "powershell.run") {
    const cmd = typeof input.command === "string" ? input.command : "";
    tracker.commandsRun.push({ toolName, input, exitCode: structuredResult.exitCode });

    const isTestCmd = /(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|check|lint|build))/.test(cmd);
    if (isTestCmd) {
      const passed = structuredResult.exitCode === 0 && structuredResult.status === "ok";
      const summary = passed
        ? "passed"
        : (structuredResult.stderrPreview || structuredResult.stdoutPreview || "failed").slice(0, 500);
      tracker.testResults.push({ command: cmd, passed, summary });
      if (!passed) tracker.fixRounds++;
    }
  }
}

/**
 * 函数 `buildDevTaskSummaryPrompt` 的职责说明。
 * `buildDevTaskSummaryPrompt` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function buildDevTaskSummaryPrompt(tracker: DevTaskTracker): string {
  const files = [...tracker.filesModified];
  const commands = tracker.commandsRun.map((c) => {
    const cmd = typeof c.input.command === "string" ? c.input.command : JSON.stringify(c.input);
    return `${cmd} (exitCode=${c.exitCode ?? "unknown"})`;
  });
  const tests = tracker.testResults.map((t) => `${t.command}: ${t.passed ? "PASSED" : "FAILED"} - ${t.summary}`);

  return [
    "[DEV_TASK_SUMMARY]",
    "This development task has completed. Please provide a final summary.",
    "",
    "Modified files:",
    files.length > 0 ? files.map((f) => `  - ${f}`).join("\n") : "  (none)",
    "",
    "Commands run:",
    commands.length > 0 ? commands.map((c) => `  - ${c}`).join("\n") : "  (none)",
    "",
    "Test results:",
    tests.length > 0 ? tests.map((t) => `  - ${t}`).join("\n") : "  (none)",
    "",
    "Fix rounds used:",
    `  ${tracker.fixRounds}`,
    "",
    "Please summarize:",
    "1. What was done",
    "2. Which files were modified and why",
    "3. Which commands were run and their results",
    "4. Whether tests/typecheck passed",
    "5. If not passed, what are the remaining issues",
  ].join("\n");
}

/**
 * 函数 `buildDevTaskSystemHint` 的职责说明。
 * `buildDevTaskSystemHint` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function buildDevTaskSystemHint(): string {
  return [
    "[DEV_TASK_MODE]",
    "You are in development task mode. Follow this workflow:",
    "1. Read relevant files first to understand the codebase",
    "2. Make a brief plan",
    "3. Modify code as needed",
    "4. Run typecheck/test to verify",
    "5. If tests fail, read the error output, fix the code, and re-run",
    "6. When all checks pass (or max fix rounds reached), provide a final summary",
    "",
    "When a command fails, always read the full error output before attempting a fix.",
    "Do not repeat the same fix if it already failed once.",
  ].join("\n");
}

export interface SerializedDevTaskTracker {
  filesModified: string[];
  commandsRun: Array<{ toolName: string; input: Record<string, unknown>; exitCode?: number }>;
  testResults: Array<{ command: string; passed: boolean; summary: string }>;
  fixRounds: number;
}

/**
 * 函数 `serializeDevTaskTracker` 的职责说明。
 * `serializeDevTaskTracker` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function serializeDevTaskTracker(tracker: DevTaskTracker): SerializedDevTaskTracker {
  return {
    filesModified: [...tracker.filesModified],
    commandsRun: tracker.commandsRun,
    testResults: tracker.testResults,
    fixRounds: tracker.fixRounds,
  };
}

/**
 * 函数 `deserializeDevTaskTracker` 的职责说明。
 * `deserializeDevTaskTracker` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function deserializeDevTaskTracker(data: unknown): DevTaskTracker | undefined {
  if (!data || typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.filesModified) || !Array.isArray(obj.commandsRun) || !Array.isArray(obj.testResults)) {
    return undefined;
  }
  return {
    filesModified: new Set(obj.filesModified.filter((f): f is string => typeof f === "string")),
    commandsRun: obj.commandsRun as DevTaskTracker["commandsRun"],
    testResults: obj.testResults as DevTaskTracker["testResults"],
    fixRounds: typeof obj.fixRounds === "number" ? obj.fixRounds : 0,
  };
}
