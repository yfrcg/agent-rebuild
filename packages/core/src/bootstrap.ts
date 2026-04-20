import * as fs from "fs";
import { getTodayDateString, getYesterdayDateString, resolveWorkspacePath } from "./config";

//Bootstrap 文件内容结构：每个文件一段，用 XML 标签包裹，方便 LLM 解析
export interface BootstrapFile {
  name: string;//文件名（不含路径）
  content: string;//文件内容（已加结构化标签）
  missing?: boolean;//文件是否缺失（用于日志输出）
}

//Bootstrap 上下文的最大体积限制：超过此值的内容会被截断（单位：字符）
//MEMORY.md 长期事实区如果超过此限制，只保留最近的 N 条，兼顾 Token 消耗和历史记忆
const MAX_BOOTSTRAP_CHARS = 6000;

//把整个 Markdown 文件内容包装成带标签的结构化文本
function wrapContent(name: string, content: string): string {
  return `<file name="${name}">\n${content.trim()}\n</file>`;
}

//对 MEMORY.md 这类可能无限增长的文件，做限量截断：只保留最近的 20 条 bullet
function trimMemoryMd(content: string): string {
  if (content.length <= MAX_BOOTSTRAP_CHARS) {
    return content;
  }

  //MEMORY.md 每个 bullet 都是 "- xxx" 格式，按行分割后从末尾取
  const lines = content.split("\n");
  const bullets: string[] = [];

  //从后向前收集 bullet 行
  for (let i = lines.length - 1; i >= 0 && bullets.join("\n").length < MAX_BOOTSTRAP_CHARS; i--) {
    const line = lines[i];
    if (line.trim().startsWith("- ")) {
      bullets.unshift(line);//从前面插入，保持原始顺序
    }
  }

  //保留标题行（# MEMORY.md 和 ## 长期事实 等）
  const headers = lines.filter((l) => l.startsWith("#"));
  const trimmed = [...headers.slice(0, 2), ...bullets].join("\n");
  return trimmed + "\n[... above content truncated by bootstrap limit ...]";
}

export function loadBootstrapContext(): { bootstrapFiles: BootstrapFile[]; bootstrapText: string } {
  const baseDir = resolveWorkspacePath();
  const fileNames = ["SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md", "TOOLS.md", "IDENTITY.md", "HEARTBEAT.md", "ToDo/to_do.md"];

  const bootstrapFiles: BootstrapFile[] = [];
  const lines: string[] = [];

  for (const fileName of fileNames) {
    const filePath = resolveWorkspacePath(fileName);
    if (!fs.existsSync(filePath)) continue;

    let content = fs.readFileSync(filePath, "utf8");

    //MEMORY.md 需要限量，防止无限膨胀把 System Prompt 撑爆
    if (fileName === "MEMORY.md") {
      content = trimMemoryMd(content);
    }

    const wrapped = wrapContent(fileName, content);
    bootstrapFiles.push({ name: fileName, content: wrapped, missing: false });
    lines.push(wrapped);
  }

  return {
    bootstrapFiles,
    //完整拼成一整个字符串，供 System Prompt 直接使用
    bootstrapText: lines.join("\n\n"),
  };
}
