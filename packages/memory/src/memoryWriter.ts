import * as fs from "fs";
import * as path from "path";
import { getTodayDateString, resolveWorkspacePath } from "../../core/src/config";

function ensureFile(filePath: string, initialContent: string) {
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, initialContent, "utf8");
  }
}

function appendBulletIfMissing(filePath: string, sectionTitle: string, bullet: string) {
  let content = fs.readFileSync(filePath, "utf8");
  const sectionHeader = `## ${sectionTitle}`;
  const bulletLine = `- ${bullet}`;

  if (content.includes(bulletLine)) {
    return;
  }

  if (!content.includes(sectionHeader)) {
    content += `\n${sectionHeader}\n${bulletLine}\n`;
    fs.writeFileSync(filePath, content, "utf8");
    return;
  }

  const insertAt = content.indexOf(sectionHeader) + sectionHeader.length;
  content = content.slice(0, insertAt) + `\n${bulletLine}` + content.slice(insertAt);
  fs.writeFileSync(filePath, content, "utf8");
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