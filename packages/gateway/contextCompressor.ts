import * as fs from "node:fs";
import * as path from "node:path";

import type { ChatMessage } from "../model/types";
import type { SessionMemoryPatch } from "./sessionMemoryManager";

const CHARS_PER_TOKEN = 4;

const BUDGET_UTILIZATION_THRESHOLD = 0.5;
const BUDGET_HIGH_UTILIZATION = 0.7;
const BUDGET_DEFAULT_MAX_CHARS = 30_000;
const BUDGET_HIGH_MAX_CHARS = 15_000;

const SNIP_UTILIZATION_THRESHOLD = 0.6;
const SNIP_PLACEHOLDER = "[Earlier tool result replaced to save context]";
const SNIPPABLE_TOOL_NAMES = new Set(["file.read", "file.list", "memory.search", "memory.get"]);
const KEEP_RECENT_RESULTS = 4;

const MICROCOMPACT_IDLE_MS = 5 * 60 * 1_000;
const MICROCOMPACT_KEEP_RECENT = 2;
const MICROCOMPACT_CLEARED = "[Old tool result cleared]";

const AUTOCOMPACT_UTILIZATION_THRESHOLD = 0.85;
const AUTOCOMPACT_SUMMARY_PREFIX = "[Context auto-compacted] ";

const LARGE_RESULT_THRESHOLD_BYTES = 30 * 1024;
const LARGE_RESULT_PREVIEW_LINES = 200;

export interface ContextCompressorOptions {
  maxContextTokens?: number;
  toolResultDir?: string;
}

export interface CompressorStats {
  tier1Budget: number;
  tier2Snip: number;
  tier3Microcompact: number;
  tier4Autocompact: boolean;
  totalCharsBefore: number;
  totalCharsAfter: number;
}

interface TrackedToolResult {
  messageIndex: number;
  toolName: string;
  filePath?: string;
  originalLength: number;
}

export class ContextCompressor {
  private readonly maxContextTokens: number;
  private readonly maxContextChars: number;
  private readonly toolResultDir: string;

  private lastApiCallTime: number | null = null;
  private lastEstimatedTokens = 0;

  constructor(options: ContextCompressorOptions = {}) {
    this.maxContextTokens = options.maxContextTokens ?? 100_000;
    this.maxContextChars = this.maxContextTokens * CHARS_PER_TOKEN;
    this.toolResultDir = options.toolResultDir ?? path.resolve(process.cwd(), "logs", "tool-results");
  }

  updateTokenEstimate(estimatedTokens: number): void {
    this.lastEstimatedTokens = estimatedTokens;
    this.lastApiCallTime = Date.now();
  }

  runPipeline(messages: ChatMessage[]): CompressorStats {
    const totalCharsBefore = this.estimateTotalChars(messages);
    const utilization = this.lastEstimatedTokens / this.maxContextTokens;

    const tier1Count = this.budgetToolResults(messages, utilization);
    const tier2Count = this.snipStaleResults(messages, utilization);
    const tier3Count = this.microcompact(messages);

    const totalCharsAfter = this.estimateTotalChars(messages);

    return {
      tier1Budget: tier1Count,
      tier2Snip: tier2Count,
      tier3Microcompact: tier3Count,
      tier4Autocompact: false,
      totalCharsBefore,
      totalCharsAfter,
    };
  }

  needsAutoCompact(messages: ChatMessage[]): boolean {
    const utilization = this.lastEstimatedTokens / this.maxContextTokens;
    return utilization >= AUTOCOMPACT_UTILIZATION_THRESHOLD && messages.length >= 5;
  }

  async autoCompact(
    messages: ChatMessage[],
    summarizer: (messages: ChatMessage[]) => Promise<string>
  ): Promise<boolean> {
    if (!this.needsAutoCompact(messages)) {
      return false;
    }

    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    if (nonSystemMessages.length < 4) {
      return false;
    }

    const toSummarize = nonSystemMessages.slice(0, -2);
    const recent = nonSystemMessages.slice(-2);

    try {
      const summary = await summarizer(toSummarize);
      const compacted: ChatMessage[] = [
        ...systemMessages,
        { role: "user" as ChatRole, content: `${AUTOCOMPACT_SUMMARY_PREFIX}${summary}` },
        { role: "assistant" as ChatRole, content: "Understood. I have the context from the previous conversation. How can I continue helping?" },
        ...recent,
      ];

      messages.length = 0;
      messages.push(...compacted);
      this.lastEstimatedTokens = this.estimateTokens(this.estimateTotalChars(messages));
      return true;
    } catch {
      return false;
    }
  }

  persistLargeResult(toolName: string, result: string): string {
    if (Buffer.byteLength(result) <= LARGE_RESULT_THRESHOLD_BYTES) {
      return result;
    }

    fs.mkdirSync(this.toolResultDir, { recursive: true });
    const filename = `${Date.now()}-${sanitizeFilename(toolName)}.txt`;
    const filepath = path.join(this.toolResultDir, filename);
    fs.writeFileSync(filepath, result);

    const lines = result.split("\n");
    const preview = lines.slice(0, LARGE_RESULT_PREVIEW_LINES).join("\n");
    const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

    return [
      `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}.]`,
      "",
      `Preview (first ${LARGE_RESULT_PREVIEW_LINES} lines):`,
      preview,
    ].join("\n");
  }

  private budgetToolResults(messages: ChatMessage[], utilization: number): number {
    if (utilization < BUDGET_UTILIZATION_THRESHOLD) {
      return 0;
    }

    const maxChars =
      utilization > BUDGET_HIGH_UTILIZATION
        ? BUDGET_HIGH_MAX_CHARS
        : BUDGET_DEFAULT_MAX_CHARS;

    let count = 0;
    for (const msg of messages) {
      if (msg.role !== "user" || !msg.content.includes("[AUTO_TOOL_RESULTS]")) {
        continue;
      }

      if (msg.content.length > maxChars) {
        const keepEach = Math.floor((maxChars - 200) / 2);
        msg.content =
          msg.content.slice(0, keepEach) +
          `\n\n[... budgeted: ${msg.content.length - keepEach * 2} chars truncated ...]\n\n` +
          msg.content.slice(-keepEach);
        count++;
      }
    }

    return count;
  }

  private snipStaleResults(messages: ChatMessage[], utilization: number): number {
    if (utilization < SNIP_UTILIZATION_THRESHOLD) {
      return 0;
    }

    const tracked = this.trackToolResults(messages);
    const seenFiles = new Map<string, number[]>();

    for (let i = 0; i < tracked.length; i++) {
      const t = tracked[i];
      if (t.filePath && SNIPPABLE_TOOL_NAMES.has(t.toolName)) {
        const existing = seenFiles.get(t.filePath) ?? [];
        existing.push(i);
        seenFiles.set(t.filePath, existing);
      }
    }

    const toSnip = new Set<number>();
    for (const indices of seenFiles.values()) {
      if (indices.length > 1) {
        for (let j = 0; j < indices.length - 1; j++) {
          toSnip.add(indices[j]);
        }
      }
    }

    let count = 0;
    for (const idx of toSnip) {
      const t = tracked[idx];
      const msg = messages[t.messageIndex];
      if (msg && msg.content !== SNIP_PLACEHOLDER && msg.content !== MICROCOMPACT_CLEARED) {
        msg.content = SNIP_PLACEHOLDER;
        count++;
      }
    }

    return count;
  }

  private microcompact(messages: ChatMessage[]): number {
    if (!this.lastApiCallTime) {
      return 0;
    }

    const idleMs = Date.now() - this.lastApiCallTime;
    if (idleMs < MICROCOMPACT_IDLE_MS) {
      return 0;
    }

    const tracked = this.trackToolResults(messages);
    if (tracked.length <= MICROCOMPACT_KEEP_RECENT) {
      return 0;
    }

    const clearCount = tracked.length - MICROCOMPACT_KEEP_RECENT;
    let count = 0;

    for (let i = 0; i < clearCount && i < tracked.length; i++) {
      const t = tracked[i];
      const msg = messages[t.messageIndex];
      if (msg && msg.content !== SNIP_PLACEHOLDER && msg.content !== MICROCOMPACT_CLEARED) {
        msg.content = MICROCOMPACT_CLEARED;
        count++;
      }
    }

    return count;
  }

  private trackToolResults(messages: ChatMessage[]): TrackedToolResult[] {
    const results: TrackedToolResult[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "user" || !msg.content.includes("[AUTO_TOOL_RESULTS]")) {
        continue;
      }

      if (msg.content === SNIP_PLACEHOLDER || msg.content === MICROCOMPACT_CLEARED) {
        continue;
      }

      const toolName = this.extractToolName(msg.content);
      const filePath = this.extractFilePath(msg.content);

      results.push({
        messageIndex: i,
        toolName,
        filePath,
        originalLength: msg.content.length,
      });
    }

    return results;
  }

  private extractToolName(content: string): string {
    const match = content.match(/tool:\s*(\S+)/);
    return match?.[1] ?? "unknown";
  }

  private extractFilePath(content: string): string | undefined {
    const pathMatch = content.match(/"(?:path|file|filePath)":\s*"([^"]+)"/);
    if (pathMatch?.[1]) {
      return pathMatch[1];
    }

    const pathMatch2 = content.match(/path:\s*(\S+)/);
    return pathMatch2?.[1];
  }

  private estimateTotalChars(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += msg.content.length + 10;
    }
    return total;
  }

  private estimateTokens(chars: number): number {
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  static extractSessionMemoryPatch(messages: ChatMessage[]): SessionMemoryPatch {
    const patch: SessionMemoryPatch = {};
    const filesTouched: string[] = [];
    const commandsRun: string[] = [];
    const failures: string[] = [];
    const facts: string[] = [];

    for (const msg of messages) {
      if (!msg.content) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.content);
      } catch {
        parsed = null;
      }

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;

        if (typeof obj.toolName === "string" && obj.input && typeof obj.input === "object") {
          const input = obj.input as Record<string, unknown>;
          const toolName = obj.toolName;

          if (toolName === "file.write" || toolName === "file.edit") {
            const filePath = typeof input.path === "string" ? input.path : "";
            if (filePath && !isSensitiveToolPath(filePath)) {
              filesTouched.push(filePath);
            }
          }

          if (toolName === "shell.run" || toolName === "bash.run") {
            const command = typeof input.command === "string" ? input.command : "";
            if (command && command.length < 200) {
              commandsRun.push(command);
            }
          }
        }

        if (typeof obj.status === "string" && obj.status === "failure") {
          const error = typeof obj.error === "string" ? obj.error : "";
          if (error) {
            failures.push(error.slice(0, 200));
          }
        }

        if (typeof obj.status === "string" && (obj.status === "ok" || obj.status === "success")) {
          if (typeof obj.result === "object" && obj.result && typeof obj.result === "object") {
            const result = obj.result as Record<string, unknown>;
            if (typeof result.stdoutPreview === "string" && result.stdoutPreview.length > 0) {
              const preview = result.stdoutPreview.slice(0, 100);
              if (preview.toLowerCase().includes("error") || preview.toLowerCase().includes("fail")) {
                failures.push(preview);
              }
            }
          }
        }
      }

      if (msg.role === "user" && msg.content.length > 10 && msg.content.length < 500) {
        const content = msg.content.trim();
        if (content.includes("必须") || content.includes("不要") || content.includes("必须") ||
            content.includes("must") || content.includes("must not") || content.includes("constraint")) {
          facts.push(content.slice(0, 200));
        }
      }
    }

    if (filesTouched.length > 0) patch.filesTouched = [...new Set(filesTouched)];
    if (commandsRun.length > 0) patch.commandsRun = [...new Set(commandsRun)];
    if (failures.length > 0) patch.failures = [...new Set(failures)].slice(-5);
    if (facts.length > 0) patch.facts = [...new Set(facts)].slice(-5);

    return patch;
  }
}

function isSensitiveToolPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replace(/\//g, "\\");
  return (
    normalized.includes("\\sessions\\") ||
    normalized.includes("\\.ssh\\") ||
    normalized.includes("\\appdata\\") ||
    normalized.includes("working-memory.json") ||
    normalized.includes("rolling-summary.md") ||
    normalized.includes("open-issues.json") ||
    normalized.includes("decisions.jsonl")
  );
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
}

type ChatRole = "system" | "user" | "assistant";
