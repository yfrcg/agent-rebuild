import * as fs from "fs";//用于文件操作
import * as path from "path";//用于路径拼接
import { getTodayDateString, resolveWorkspacePath } from "../../core/src/config";//用于获取日期和解析路径
import { upsertFileIndex } from "./memoryIndex";//用于写入后触发增量索引

//确保文件所在目录存在，文件不存在则创建
function ensureFile(filePath: string, initialContent: string) {
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, initialContent, "utf8");
  }
}

//将 bullet 追加到指定小节，如果已存在则跳过（去重）
function appendBulletIfMissing(filePath: string, sectionTitle: string, bullet: string) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  //【安全修复】：过滤 AI 输入的换行符，确保 bullet 始终是单行（防止 Markdown 结构破坏）
  const sanitizedBullet = bullet.trim().replace(/\r?\n/g, " ");
  const bulletLine = `- ${sanitizedBullet}`;

  //【修复1】：精准的行级比对，杜绝 "Apple" 匹配到 "Apple Pie" 的误判问题
  const hasBullet = lines.some((line) => line.trim() === bulletLine);
  if (hasBullet) {
    return;
  }

  const sectionHeader = `## ${sectionTitle}`;

  //精准定位目标 Header 所在行号（trim 后比对，防止末尾空格差异）
  const headerIndex = lines.findIndex((line) => line.trim() === sectionHeader);

  if (headerIndex === -1) {
    //没找到对应章节，在文件末尾追加新章节和 bullet
    fs.appendFileSync(filePath, `\n\n${sectionHeader}\n${bulletLine}\n`, "utf8");
    upsertFileIndex(filePath);
    return;
  }

  //找到章节，在章节标题的正下方（headerIndex + 1）插入新记忆
  lines.splice(headerIndex + 1, 0, bulletLine);
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  upsertFileIndex(filePath);
}

export function writeLongTermMemory(text: string) {
  const filePath = resolveWorkspacePath("MEMORY.md");
  ensureFile(filePath, "# MEMORY.md\n");
  appendBulletIfMissing(filePath, "长期事实", text);
}

export function writeDailyMemory(text: string) {
  const today = getTodayDateString();
  const filePath = resolveWorkspacePath("memory", `${today}.md`);
  ensureFile(filePath, `# ${today}\n\n## Notes\n`);
  appendBulletIfMissing(filePath, "Notes", text);
}
