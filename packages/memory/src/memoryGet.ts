import * as fs from "fs";//用于操作文件
import { resolveWorkspacePath } from "../../core/src/config";//引入的自定义函数，将一个相对路径转换为项目中的绝对路径

//memoryGet 的返回值类型，包含文本内容和元数据
export interface MemoryGetResult {
  file: string;//文件名
  startLine: number;//起始行号
  endLine: number;//结束行号
  charCount: number;//原始字符数
  tokenEstimate: number;//估算 token 数量（用于判断是否超过 LLM 上下文窗口）
  text: string;//实际返回的文本内容（已做长度截断）
}

//估算 token 数量的简单方法（不够精确但够用）：中文字符约 2 token/字，英文约 0.25 token/字符
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    if (char.charCodeAt(0) > 127) {
      tokens += 2;//CJK 字符
    } else {
      tokens += 0.25;//ASCII 字符
    }
  }
  return Math.ceil(tokens);
}

//读取 file 的指定行范围，支持负数和倒置，自动纠正为合法范围
export function memoryGet(file: string, startLine?: number, endLine?: number): MemoryGetResult {
  const filePath = resolveWorkspacePath(file);//安全校验：防止 path traversal 攻击

  if (!fs.existsSync(filePath)) {
    throw new Error(`Memory file not found: ${file}`);
  }

  //读取文件与行号计算
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  //起始行：默认1，最小为1（避免0行）
  const s = startLine ? Math.max(1, startLine) : 1;
  //结束行：默认文件末尾，最大为文件总行数
  const e = endLine ? Math.min(lines.length, endLine) : lines.length;

  //自动纠正倒置（如果 AI 发出了 start > end 的指令，交换两者）
  let start = s;
  let end = e;
  if (start > end) {
    [start, end] = [end, start];
  }

  //按行切片得到原始文本
  const rawText = lines.slice(start - 1, end).join("\n");
  const charCount = rawText.length;

  //大文件保护：单个 chunk 超过 2000 token 近似值时做截断（LLM 上下文窗口有限）
  const MAX_TOKENS = 2000;
  let text = rawText;
  let tokenEstimate = estimateTokens(rawText);

  if (tokenEstimate > MAX_TOKENS) {
    //从文件末尾向前计算，直到 token 数降到限制内（优先保留最新的内容）
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
