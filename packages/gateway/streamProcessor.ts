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

  processTextChunk(chunk: string): void {
    this.buffer += chunk;
    this.fullText += chunk;
    this.handlers.onTextDelta(chunk);
  }

  getFullText(): string {
    return this.fullText;
  }

  getBuffer(): string {
    return this.buffer;
  }

  clearBuffer(): void {
    this.buffer = "";
  }

  reset(): void {
    this.buffer = "";
    this.fullText = "";
  }

  finalize(): string {
    const result = this.fullText;
    this.handlers.onDone(result);
    this.reset();
    return result;
  }

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

  truncateGlobally(text: string): string {
    if (text.length <= GLOBAL_TRUNCATION_THRESHOLD) {
      return text;
    }

    const head = text.slice(0, HEAD_KEEP);
    const tail = text.slice(-TAIL_KEEP);
    const skippedChars = text.length - HEAD_KEEP - TAIL_KEEP;

    return `${head}${TRUNCATION_SUFFIX.replace("...", `${skippedChars} chars`)}${tail}`;
  }

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

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
}
