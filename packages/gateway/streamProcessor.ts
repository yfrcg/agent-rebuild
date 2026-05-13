/**
 * ?????CS336 ???
 * ???packages/gateway/streamProcessor.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface StreamChunk {
  type: "text_delta" | "tool_start" | "tool_end" | "error" | "done";
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  error?: string;
}

export interface StreamProcessorOptions {
  onTextDelta?: (text: string) => void;
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  onToolEnd?: (toolName: string, result: string) => void;
  onError?: (error: string) => void;
  onDone?: (fullText: string) => void;
  toolResultDir?: string;
}

const LARGE_RESULT_THRESHOLD = 30 * 1024;
const LARGE_RESULT_PREVIEW_LINES = 200;
const TRUNCATION_SUFFIX = "\n[... truncated to save context ...]";
const GLOBAL_TRUNCATION_THRESHOLD = 20_000;
const HEAD_KEEP = 10_000;
const TAIL_KEEP = 8_000;

export class StreamProcessor {
  private buffer = "";
  private fullText = "";
  private readonly handlers: Required<
    Pick<StreamProcessorOptions, "onTextDelta" | "onToolStart" | "onToolEnd" | "onError" | "onDone">
  >;
  private readonly toolResultDir: string;

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(options: StreamProcessorOptions = {}) {
    this.handlers = {
      onTextDelta: options.onTextDelta ?? (() => {}),
      onToolStart: options.onToolStart ?? (() => {}),
      onToolEnd: options.onToolEnd ?? (() => {}),
      onError: options.onError ?? (() => {}),
      onDone: options.onDone ?? (() => {}),
    };
    this.toolResultDir = options.toolResultDir ?? path.resolve(process.cwd(), "logs", "tool-results");
  }

  /**
   * 方法 `processTextChunk` 的职责说明。
   * `processTextChunk` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  processTextChunk(chunk: string): void {
    this.buffer += chunk;
    this.fullText += chunk;
    this.handlers.onTextDelta(chunk);
  }

  /**
   * 方法 `getFullText` 的职责说明。
   * `getFullText` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  getFullText(): string {
    return this.fullText;
  }

  /**
   * 方法 `getBuffer` 的职责说明。
   * `getBuffer` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  getBuffer(): string {
    return this.buffer;
  }

  /**
   * 方法 `clearBuffer` 的职责说明。
   * `clearBuffer` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  clearBuffer(): void {
    this.buffer = "";
  }

  /**
   * 方法 `reset` 的职责说明。
   * `reset` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  reset(): void {
    this.buffer = "";
    this.fullText = "";
  }

  /**
   * 方法 `finalize` 的职责说明。
   * `finalize` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  finalize(): string {
    const result = this.fullText;
    this.handlers.onDone(result);
    this.reset();
    return result;
  }

  /**
   * 方法 `persistLargeResult` 的职责说明。
   * `persistLargeResult` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  persistLargeResult(toolName: string, result: string): string {
    if (Buffer.byteLength(result) <= LARGE_RESULT_THRESHOLD) {
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

  /**
   * 方法 `truncateGlobally` 的职责说明。
   * `truncateGlobally` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  truncateGlobally(text: string): string {
    if (text.length <= GLOBAL_TRUNCATION_THRESHOLD) {
      return text;
    }

    const head = text.slice(0, HEAD_KEEP);
    const tail = text.slice(-TAIL_KEEP);
    const skippedChars = text.length - HEAD_KEEP - TAIL_KEEP;

    return `${head}${TRUNCATION_SUFFIX.replace("...", `${skippedChars} chars`)}${tail}`;
  }

  /**
   * 方法 `emitChunk` 的职责说明。
   * `emitChunk` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  emitChunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case "text_delta":
        if (chunk.content) {
          this.handlers.onTextDelta(chunk.content);
        }
        break;
      case "tool_start":
        if (chunk.toolName) {
          this.handlers.onToolStart(chunk.toolName, chunk.toolArgs ?? {});
        }
        break;
      case "tool_end":
        if (chunk.toolName && chunk.toolResult !== undefined) {
          this.handlers.onToolEnd(chunk.toolName, chunk.toolResult);
        }
        break;
      case "error":
        if (chunk.error) {
          this.handlers.onError(chunk.error);
        }
        break;
      case "done":
        this.handlers.onDone(this.fullText);
        break;
    }
  }

  /**
   * 方法 `collectChunks` 的职责说明。
   * `collectChunks` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  collectChunks(chunks: StreamChunk[]): { text: string; toolCalls: Array<{ name: string; args: Record<string, unknown>; result?: string }> } {
    let text = "";
    const toolCalls: Array<{ name: string; args: Record<string, unknown>; result?: string }> = [];
    let currentTool: { name: string; args: Record<string, unknown> } | null = null;

    for (const chunk of chunks) {
      switch (chunk.type) {
        case "text_delta":
          text += chunk.content ?? "";
          break;
        case "tool_start":
          currentTool = { name: chunk.toolName ?? "unknown", args: chunk.toolArgs ?? {} };
          break;
        case "tool_end":
          if (currentTool) {
            toolCalls.push({ ...currentTool, result: chunk.toolResult });
            currentTool = null;
          }
          break;
      }
    }

    return { text, toolCalls };
  }
}

/**
 * 函数 `sanitizeFilename` 的职责说明。
 * `sanitizeFilename` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
}
