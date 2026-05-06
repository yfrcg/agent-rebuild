
import * as fs from "fs";
import { resolveWorkspacePath } from "../../core/src/config";

/**
 * `memoryGet()` 的返回结构。
 *
 * 除了文本正文，还会返回行号范围、字符数和 token 估算值，
 * 方便调用方判断结果是否过长、是否需要继续裁剪。
 */
export interface MemoryGetResult {
  file: string;
  startLine: number;
  endLine: number;
  charCount: number;
  tokenEstimate: number;
  text: string;
}

/**
 * 粗略估算文本 token 数量。
 *
 * 这里只做启发式估算：
 * - 非 ASCII 字符按 2 token 估
 * - ASCII 字符按 0.25 token 估
 * 精度不如 tokenizer，但足够用于本地保护阈值判断。
 */
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    if (char.charCodeAt(0) > 127) {
      tokens += 2;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

/**
 * 读取工作区内某个文件的指定行范围。
 *
 * 该函数会自动完成：
 * - 路径安全校验
 * - 起止行号纠正
 * - 大文本裁剪保护
 */
export function memoryGet(file: string, startLine?: number, endLine?: number): MemoryGetResult {
  const filePath = resolveWorkspacePath(file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Memory file not found: ${file}`);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  const s = startLine ? Math.max(1, startLine) : 1;
  const e = endLine ? Math.min(lines.length, endLine) : lines.length;

  let start = s;
  let end = e;
  if (start > end) {
    [start, end] = [end, start];
  }

  const rawText = lines.slice(start - 1, end).join("\n");
  const charCount = rawText.length;

  // 单次返回过大的文本会影响上下文窗口，因此做近似 token 裁剪。
  const MAX_TOKENS = 2000;
  let text = rawText;
  let tokenEstimate = estimateTokens(rawText);

  if (tokenEstimate > MAX_TOKENS) {
    const reversedLines = lines.slice(0, end).reverse();
    const allowedLines: string[] = [];
    let accTokens = 0;

    for (const line of reversedLines) {
      const lineTokens = estimateTokens(line + "\n");
      if (accTokens + lineTokens > MAX_TOKENS) break;
      allowedLines.unshift(line);
      accTokens += lineTokens;
    }

    text = allowedLines.join("\n");
    tokenEstimate = accTokens;
  }

  return {
    file,
    startLine: start,
    endLine: end,
    charCount,
    tokenEstimate,
    text,
  };
}
