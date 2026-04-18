import * as fs from "fs";
import * as path from "path";
import { getTodayDateString, resolveWorkspacePath } from "../../core/src/config";
//这个函数是确保AI记录的时候文件和文件夹一定是存在的。
function ensureFile(filePath: string, initialContent: string) {
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, initialContent, "utf8");
  }
}
//负责把新的记忆以Markdown无序列表的形式插入到文件里面
function appendBulletIfMissing(filePath: string, sectionTitle: string, bullet: string) {
  let content = fs.readFileSync(filePath, "utf8");
  const sectionHeader = `## ${sectionTitle}`;
  const bulletLine = `- ${bullet}`;
  //去重机制
  if (content.includes(bulletLine)) {
    return;
  }

  if (!content.includes(sectionHeader)) {
    content += `\n${sectionHeader}\n${bulletLine}\n`;
    fs.writeFileSync(filePath, content, "utf8");
    return;
  }
  /*
  情况 A（没找到对应小节）：如果文档里连这个标题（比如 ## 长期事实）都没有，它就在文件最末尾另起一行，把标题和记忆一起写进去。

  情况 B（找到了对应小节）：如果标题已经存在，它会利用 content.indexOf 找到标题所在的位置，然后巧妙地使用字符串切片（slice），把新记忆精准地塞到这个标题的正下方。
  */

  const insertAt = content.indexOf(sectionHeader) + sectionHeader.length;
  content = content.slice(0, insertAt) + `\n${bulletLine}` + content.slice(insertAt);
  fs.writeFileSync(filePath, content, "utf8");
}
//写入长期记忆
export function writeLongTermMemory(text: string) {
  const filePath = resolveWorkspacePath("MEMORY.md");
  ensureFile(filePath, "# MEMORY.md\n");
  appendBulletIfMissing(filePath, "长期事实", text);
}
//写入日常记忆
export function writeDailyMemory(text: string) {
  const today = getTodayDateString();
  const filePath = resolveWorkspacePath("memory", `${today}.md`);
  ensureFile(filePath, `# ${today}\n\n## Notes\n`);
  appendBulletIfMissing(filePath, "Notes", text);
}