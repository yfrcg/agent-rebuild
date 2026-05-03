import * as fs from "fs";
import { resolveWorkspacePath } from "./config";
import {
  discoverSkills,
  renderSkillInventory,
  selectSkills,
} from "./skills";

/**
 * 启动上下文中单个文件的结构化表示。
 *
 * `content` 会被包装成带标签的文本片段，便于后续直接拼进系统提示词。
 */
export interface BootstrapFile {
  name: string;
  content: string;
  missing?: boolean;
}

export interface BootstrapContextResult {
  bootstrapFiles: BootstrapFile[];
  bootstrapText: string;
  discoveredSkillCount: number;
  activatedSkills: string[];
  matchedSkills: string[];
  skillSelectionStrategy: "explicit" | "session" | "auto" | "mixed" | "none";
}

export interface BootstrapContextOptions {
  userInput?: string;
  activeSkillNames?: string[];
  maxActivatedSkills?: number;
}

/**
 * Bootstrap 文本的最大字符数限制。
 *
 * 这个限制主要用来约束 `MEMORY.md` 一类会不断增长的文件，
 * 避免启动上下文无限膨胀，把提示词窗口挤爆。
 */
const MAX_BOOTSTRAP_CHARS = 6000;

/**
 * 把普通文件内容包装成带名字的结构化片段。
 *
 * 这样做的目的是让模型在读取拼接后的大段上下文时，
 * 依然能清晰知道每一部分来自哪个文件。
 */
function wrapContent(name: string, content: string): string {
  return `<file name="${name}">\n${content.trim()}\n</file>`;
}

/**
 * 对 `MEMORY.md` 做长度裁剪，只保留最近的关键记忆。
 *
 * 裁剪策略不是粗暴截断前 N 个字符，而是优先保留：
 * 1. 文件标题与章节标题。
 * 2. 文件尾部最近的 bullet 记忆。
 * 这样更符合“近期记忆优先”的使用目标。
 */
function trimMemoryMd(content: string): string {
  if (content.length <= MAX_BOOTSTRAP_CHARS) {
    return content;
  }

  const lines = content.split("\n");
  const bullets: string[] = [];

  // 从后往前收集 bullet，可以更大概率保住最近新增的长期事实。
  for (
    let i = lines.length - 1;
    i >= 0 && bullets.join("\n").length < MAX_BOOTSTRAP_CHARS;
    i -= 1
  ) {
    const line = lines[i];
    if (line.trim().startsWith("- ")) {
      bullets.unshift(line);
    }
  }

  // 标题保留前两个层级，帮助模型知道这些 bullet 属于什么语义区块。
  const headers = lines.filter((line) => line.startsWith("#"));
  const trimmed = [...headers.slice(0, 2), ...bullets].join("\n");
  return `${trimmed}\n[... above content truncated by bootstrap limit ...]`;
}

/**
 * 从 workspace 中加载系统启动上下文。
 *
 * 它会把人格、用户信息、长期记忆、工具说明和待办事项等关键文件读出来，
 * 再合并成一段可直接注入模型的 bootstrap 文本。
 */
export function loadBootstrapContext(
  options: BootstrapContextOptions = {}
): BootstrapContextResult {
  const fileNames = [
    "SOUL.md",
    "USER.md",
    "MEMORY.md",
    "AGENTS.md",
    "TOOLS.md",
    "IDENTITY.md",
    "HEARTBEAT.md",
    "ToDo/to_do.md",
  ];

  const bootstrapFiles: BootstrapFile[] = [];
  const lines: string[] = [];

  for (const fileName of fileNames) {
    const filePath = resolveWorkspacePath(fileName);
    if (!fs.existsSync(filePath)) continue;

    let content = fs.readFileSync(filePath, "utf8");

    // 只有 MEMORY.md 需要额外裁剪，其余文件保持原样更安全。
    if (fileName === "MEMORY.md") {
      content = trimMemoryMd(content);
    }

    const wrapped = wrapContent(fileName, content);
    bootstrapFiles.push({ name: fileName, content: wrapped, missing: false });
    lines.push(wrapped);
  }

  const skillDiscovery = discoverSkills();
  if (skillDiscovery.skills.length > 0) {
    const inventoryWrapped = wrapContent(
      "SKILLS.md",
      renderSkillInventory(skillDiscovery.skills)
    );
    bootstrapFiles.push({
      name: "SKILLS.md",
      content: inventoryWrapped,
      missing: false,
    });
    lines.push(inventoryWrapped);
  }

  const skillSelection = selectSkills({
    userInput: options.userInput ?? "",
    availableSkills: skillDiscovery.skills,
    activeSkillNames: options.activeSkillNames,
    maxMatches: options.maxActivatedSkills ?? 3,
  });

  for (const skill of skillSelection.selectedSkills) {
    const wrapped = wrapContent(
      `skills/${skill.name}/SKILL.md`,
      skill.content
    );
    bootstrapFiles.push({
      name: `skills/${skill.name}/SKILL.md`,
      content: wrapped,
      missing: false,
    });
    lines.push(wrapped);
  }

  return {
    bootstrapFiles,
    bootstrapText: lines.join("\n\n"),
    discoveredSkillCount: skillDiscovery.skills.length,
    activatedSkills: skillSelection.selectedSkills.map((skill) => skill.name),
    matchedSkills: skillSelection.matchedSkills.map((skill) => skill.name),
    skillSelectionStrategy: skillSelection.strategy,
  };
}
