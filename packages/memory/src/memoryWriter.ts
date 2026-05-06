
import * as fs from "fs";
import * as path from "path";
import { getTodayDateString, resolveWorkspacePath } from "../../core/src/config";
import { upsertFileIndex } from "./memoryIndex";

/**
 * 确保目标文件存在。
 *
 * 若父目录不存在则先创建目录；
 * 若文件不存在则写入初始内容。
 */
function ensureFile(filePath: string, initialContent: string) {
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, initialContent, "utf8");
  }
}

/**
 * 向指定章节追加一条 bullet，若已存在则跳过。
 *
 * 这个函数承担了两个关键职责：
 * 1. 去重，防止同一记忆被重复写入。
 * 2. 维护 Markdown 结构，确保内容落在正确章节下。
 */
function appendBulletIfMissing(filePath: string, sectionTitle: string, bullet: string) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  // 过滤换行，防止输入把 Markdown 结构意外打坏。
  const sanitizedBullet = bullet.trim().replace(/\r?\n/g, " ");
  const bulletLine = `- ${sanitizedBullet}`;

  const hasBullet = lines.some((line) => line.trim() === bulletLine);
  if (hasBullet) {
    return;
  }

  const sectionHeader = `## ${sectionTitle}`;
  const headerIndex = lines.findIndex((line) => line.trim() === sectionHeader);

  if (headerIndex === -1) {
    fs.appendFileSync(filePath, `\n\n${sectionHeader}\n${bulletLine}\n`, "utf8");
    upsertFileIndex(filePath);
    return;
  }

  lines.splice(headerIndex + 1, 0, bulletLine);
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  upsertFileIndex(filePath);
}

/**
 * 写入长期记忆。
 *
 * 最终落盘到 `workspace/MEMORY.md` 的“长期事实”章节。
 */
export function writeLongTermMemory(text: string): string {
  const filePath = resolveWorkspacePath("MEMORY.md");
  ensureFile(filePath, "# MEMORY.md\n");
  appendBulletIfMissing(filePath, "长期事实", text);
  return filePath;
}

/**
 * 写入当天记忆。
 *
 * 最终落盘到 `workspace/memory/YYYY-MM-DD.md` 的 `Notes` 章节。
 */
export function writeDailyMemory(text: string): string {
  const today = getTodayDateString();
  const filePath = resolveWorkspacePath("memory", `${today}.md`);
  ensureFile(filePath, `# ${today}\n\n## Notes\n`);
  appendBulletIfMissing(filePath, "Notes", text);
  return filePath;
}
