/**
 * ?????CS336 ???
 * ???packages/core/src/skills.ts
 * ??????????
 * ?????????????????? Skill ?????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { ROOT_DIR, WORKSPACE_DIR } from "./config";

export type SkillContext = "inline" | "fork";

export interface SkillDefinition {
  name: string;
  title: string;
  description: string;
  path: string;
  relativePath: string;
  platform: string;
  content: string;
  aliases: string[];
  priority: number;
  conflicts: string[];
  whenToUse?: string;
  allowedTools?: string[];
  userInvocable: boolean;
  context: SkillContext;
  source: "project" | "user";
  skillDir: string;
}

interface SkillSource {
  platform: string;
  root: string;
  source: "project" | "user";
}

export interface SkillDiscoveryResult {
  skills: SkillDefinition[];
  sources: SkillSource[];
}

export interface SkillSelectionOptions {
  maxMatches?: number;
}

export interface SkillSelectionResult {
  selectedSkills: SkillDefinition[];
  matchedSkills: SkillDefinition[];
  strategy: "explicit" | "session" | "auto" | "mixed" | "none";
}

const SKILL_FILE_NAME = "SKILL.md";
const MAX_SKILL_CONTENT_CHARS = 4000;

/**
 * 函数 `getHomeDir` 的职责说明。
 * `getHomeDir` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function getHomeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
}

const DEFAULT_SKILL_SOURCES: SkillSource[] = [
  {
    platform: "user-global",
    root: path.join(getHomeDir(), ".agent-rebuild", "skills"),
    source: "user",
  },
  {
    platform: "user-claude",
    root: path.join(getHomeDir(), ".claude", "skills"),
    source: "user",
  },
  {
    platform: "workspace",
    root: path.join(WORKSPACE_DIR, "skills"),
    source: "project",
  },
  {
    platform: "repo",
    root: path.join(ROOT_DIR, "skills"),
    source: "project",
  },
  {
    platform: "codex",
    root: path.join(ROOT_DIR, ".codex", "skills"),
    source: "project",
  },
  {
    platform: "trae",
    root: path.join(ROOT_DIR, ".trae", "skills"),
    source: "project",
  },
  {
    platform: "claude",
    root: path.join(ROOT_DIR, ".claude", "skills"),
    source: "project",
  },
];

/**
 * 函数 `discoverSkills` 的职责说明。
 * `discoverSkills` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function discoverSkills(): SkillDiscoveryResult {
  const skills: SkillDefinition[] = [];
  const seenPaths = new Set<string>();

  for (const source of DEFAULT_SKILL_SOURCES) {
    if (!fs.existsSync(source.root)) {
      continue;
    }

    for (const filePath of findSkillFiles(source.root)) {
      const normalizedPath = path.normalize(filePath);
      if (seenPaths.has(normalizedPath)) {
        continue;
      }

      seenPaths.add(normalizedPath);
      skills.push(readSkillFile(source, filePath));
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));

  return {
    skills,
    sources: DEFAULT_SKILL_SOURCES,
  };
}

/**
 * 函数 `selectSkillsForUserInput` 的职责说明。
 * `selectSkillsForUserInput` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function selectSkillsForUserInput(
  userInput: string,
  skills: SkillDefinition[],
  options: SkillSelectionOptions = {}
): SkillDefinition[] {
  return selectSkills({
    userInput,
    availableSkills: skills,
    maxMatches: options.maxMatches,
  }).selectedSkills;
}

/**
 * 函数 `selectSkills` 的职责说明。
 * `selectSkills` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function selectSkills(input: {
  userInput: string;
  availableSkills: SkillDefinition[];
  activeSkillNames?: string[];
  maxMatches?: number;
}): SkillSelectionResult {
  const maxMatches = input.maxMatches ?? 3;
  const normalizedInput = normalizeKey(input.userInput);
  const explicitMentions = collectExplicitMentions(input.userInput);

  const ranked = input.availableSkills
    .map((skill) => ({
      skill,
      match: computeSkillMatchScore(skill, input.userInput, normalizedInput, explicitMentions),
    }))
    .filter((item) => item.match.selected)
    .sort(
      (a, b) =>
        b.skill.priority - a.skill.priority ||
        b.match.score - a.match.score ||
        a.skill.name.localeCompare(b.skill.name)
    )
    .slice(0, maxMatches);

  const explicitMatches = ranked
    .filter((item) => item.match.source === "explicit")
    .map((item) => item.skill);
  const autoMatches = ranked
    .filter((item) => item.match.source === "auto")
    .map((item) => item.skill);
  const activeMatches = matchActiveSkills(input.activeSkillNames ?? [], input.availableSkills);
  const merged = resolveSkillConflicts(
    dedupeSkills([...activeMatches, ...explicitMatches, ...autoMatches])
  ).slice(0, maxMatches);

  return {
    selectedSkills: merged,
    matchedSkills: [...explicitMatches, ...autoMatches],
    strategy: inferSelectionStrategy(explicitMatches, autoMatches, activeMatches),
  };
}

/**
 * 函数 `renderSkillInventory` 的职责说明。
 * `renderSkillInventory` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function renderSkillInventory(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return [
      "# SKILLS",
      "",
      "No compatible SKILL.md files were discovered in the configured skill roots.",
    ].join("\n");
  }

  return [
    "# SKILLS",
    "",
    "Discovered compatible SKILL.md files:",
    ...skills.map(
      (skill, index) =>
        `${index + 1}. ${skill.name} [platform=${skill.platform}] ${skill.description} (${skill.relativePath})`
    ),
    "",
    "When the user explicitly mentions a skill, inject the matched SKILL.md content before answering.",
  ].join("\n");
}

/**
 * 函数 `getSkillByName` 的职责说明。
 * `getSkillByName` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function getSkillByName(
  name: string,
  skills?: SkillDefinition[]
): SkillDefinition | undefined {
  const list = skills ?? discoverSkills().skills;
  const normalized = normalizeSkillName(name);
  return list.find(
    (skill) =>
      skill.name === normalized ||
      skill.aliases.includes(normalized)
  );
}

/**
 * 函数 `resolveSkillPrompt` 的职责说明。
 * `resolveSkillPrompt` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function resolveSkillPrompt(skill: SkillDefinition, args: string): string {
  let prompt = skill.content;
  prompt = prompt.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args);
  prompt = prompt.replace(/\$\{SKILL_DIR\}/g, skill.skillDir);
  return prompt;
}

/**
 * 函数 `buildSkillDescriptions` 的职责说明。
 * `buildSkillDescriptions` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function buildSkillDescriptions(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return "";
  }

  const lines: string[] = ["# Available Skills", ""];
  const invocable = skills.filter((s) => s.userInvocable);
  const autoOnly = skills.filter((s) => !s.userInvocable);

  if (invocable.length > 0) {
    lines.push("User-invocable skills (user types /<name> to invoke):");
    for (const s of invocable) {
      lines.push(`- **/${s.name}**: ${s.description}`);
      if (s.whenToUse) {
        lines.push(`  When to use: ${s.whenToUse}`);
      }
    }
    lines.push("");
  }

  if (autoOnly.length > 0) {
    lines.push("Auto-invocable skills (use the `skill` tool when appropriate):");
    for (const s of autoOnly) {
      lines.push(`- **${s.name}**: ${s.description}`);
      if (s.whenToUse) {
        lines.push(`  When to use: ${s.whenToUse}`);
      }
    }
    lines.push("");
  }

  lines.push(
    "To invoke a skill programmatically, use the `skill` tool with the skill name and optional arguments."
  );

  return lines.join("\n");
}

/**
 * 函数 `findSkillFiles` 的职责说明。
 * `findSkillFiles` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function findSkillFiles(root: string): string[] {
  const result: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }

    const entries = fs.readdirSync(current, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (
        entry.isFile() &&
        entry.name.toUpperCase() === SKILL_FILE_NAME.toUpperCase()
      ) {
        result.push(fullPath);
      }
    }
  }

  return result;
}

/**
 * 函数 `readSkillFile` 的职责说明。
 * `readSkillFile` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function readSkillFile(source: SkillSource, filePath: string): SkillDefinition {
  const rawContent = fs.readFileSync(filePath, "utf8");
  const metadata = extractSkillMetadata(rawContent);
  const title = extractSkillTitle(metadata.body, filePath);
  const description = extractSkillDescription(metadata.body);
  const relativePath = path.relative(ROOT_DIR, filePath).replace(/\\/g, "/");
  const skillDir = path.dirname(filePath);
  const directoryName = path.basename(skillDir);
  const name = normalizeSkillName(directoryName || title);
  const aliases = collectAliases(name, title, description, metadata.aliases);

  return {
    name,
    title,
    description,
    path: filePath,
    relativePath,
    platform: source.platform,
    content: trimSkillContent(metadata.body),
    aliases,
    priority: metadata.priority,
    conflicts: metadata.conflicts.map(normalizeSkillName),
    whenToUse: metadata.whenToUse,
    allowedTools: metadata.allowedTools,
    userInvocable: metadata.userInvocable,
    context: metadata.context,
    source: source.source,
    skillDir,
  };
}

/**
 * 函数 `extractSkillTitle` 的职责说明。
 * `extractSkillTitle` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function extractSkillTitle(content: string, filePath: string): string {
  const lines = content.split(/\r?\n/);
  const heading = lines.find((line) => line.trim().startsWith("#"));
  if (heading) {
    return heading.replace(/^#+\s*/, "").trim();
  }

  return path.basename(path.dirname(filePath));
}

/**
 * 函数 `extractSkillDescription` 的职责说明。
 * `extractSkillDescription` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function extractSkillDescription(content: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const description = lines.find(
    (line) => line && !line.startsWith("#") && !line.startsWith("-") && !line.startsWith("*")
  );

  return description ?? "No description provided.";
}

/**
 * 函数 `collectAliases` 的职责说明。
 * `collectAliases` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function collectAliases(
  name: string,
  title: string,
  description: string,
  extraAliases: string[]
): string[] {
  const aliases = new Set<string>();
  aliases.add(name);
  aliases.add(normalizeSkillName(title));

  const titleParts = title
    .split(/[\s/|,:()]+/)
    .map(normalizeSkillName)
    .filter((part) => part.length >= 4 && !GENERIC_SKILL_TERMS.has(part));
  for (const part of titleParts) {
    aliases.add(part);
  }

  const skillTagMatch = description.match(/`([^`]+)`/g) ?? [];
  for (const tag of skillTagMatch) {
    aliases.add(normalizeSkillName(tag.replace(/`/g, "")));
  }

  for (const alias of extraAliases) {
    aliases.add(normalizeSkillName(alias));
  }

  return [...aliases].filter(Boolean);
}

/**
 * 函数 `trimSkillContent` 的职责说明。
 * `trimSkillContent` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function trimSkillContent(content: string): string {
  if (content.length <= MAX_SKILL_CONTENT_CHARS) {
    return content.trim();
  }

  const safeMax = MAX_SKILL_CONTENT_CHARS - 48;
  return `${content.slice(0, safeMax).trim()}\n\n[skill content truncated]`;
}

/**
 * 函数 `collectExplicitMentions` 的职责说明。
 * `collectExplicitMentions` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function collectExplicitMentions(userInput: string): Set<string> {
  const mentions = new Set<string>();
  const matches = userInput.match(/[@$]([A-Za-z0-9._/-]+)/g) ?? [];

  for (const match of matches) {
    mentions.add(normalizeSkillName(match.slice(1)));
  }

  return mentions;
}

/**
 * 函数 `matchActiveSkills` 的职责说明。
 * `matchActiveSkills` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function matchActiveSkills(
  activeSkillNames: string[],
  skills: SkillDefinition[]
): SkillDefinition[] {
  if (activeSkillNames.length === 0) {
    return [];
  }

  const normalized = new Set(activeSkillNames.map(normalizeSkillName));
  return skills.filter(
    (skill) =>
      normalized.has(skill.name) ||
      skill.aliases.some((alias) => normalized.has(alias))
  );
}

/**
 * 函数 `computeSkillMatchScore` 的职责说明。
 * `computeSkillMatchScore` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function computeSkillMatchScore(
  skill: SkillDefinition,
  rawInput: string,
  normalizedInput: string,
  explicitMentions: Set<string>
): {
  score: number;
  selected: boolean;
  source: "explicit" | "auto" | "none";
} {
  let score = 0;
  let aliasHits = 0;
  let explicitHit = false;

  for (const alias of skill.aliases) {
    if (!alias) {
      continue;
    }

    if (explicitMentions.has(alias)) {
      score += 100;
      explicitHit = true;
    }

    if (normalizedInput.includes(alias)) {
      score += alias.length >= 6 ? 12 : 6;
      aliasHits += 1;
    }
  }

  if (rawInput.includes(skill.title)) {
    score += 20;
  }

  if (explicitHit) {
    return {
      score,
      selected: true,
      source: "explicit",
    };
  }

  const selected = score >= 20 || aliasHits >= 2;
  return {
    score,
    selected,
    source: selected ? "auto" : "none",
  };
}

/**
 * 函数 `normalizeSkillName` 的职责说明。
 * `normalizeSkillName` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizeSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * 函数 `dedupeSkills` 的职责说明。
 * `dedupeSkills` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function dedupeSkills(skills: SkillDefinition[]): SkillDefinition[] {
  const seen = new Set<string>();
  const result: SkillDefinition[] = [];

  for (const skill of skills) {
    if (seen.has(skill.name)) {
      continue;
    }
    seen.add(skill.name);
    result.push(skill);
  }

  return result;
}

/**
 * 函数 `inferSelectionStrategy` 的职责说明。
 * `inferSelectionStrategy` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function inferSelectionStrategy(
  explicitMatches: SkillDefinition[],
  autoMatches: SkillDefinition[],
  activeMatches: SkillDefinition[]
): "explicit" | "session" | "auto" | "mixed" | "none" {
  const usedSources = [
    explicitMatches.length > 0 ? "explicit" : undefined,
    autoMatches.length > 0 ? "auto" : undefined,
    activeMatches.length > 0 ? "session" : undefined,
  ].filter(Boolean);

  if (usedSources.length > 1) {
    return "mixed";
  }

  if (explicitMatches.length > 0) {
    return "explicit";
  }

  if (autoMatches.length > 0) {
    return "auto";
  }

  if (activeMatches.length > 0) {
    return "session";
  }

  return "none";
}

/**
 * 函数 `normalizeKey` 的职责说明。
 * `normalizeKey` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 函数 `extractSkillMetadata` 的职责说明。
 * `extractSkillMetadata` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function extractSkillMetadata(content: string): {
  body: string;
  priority: number;
  conflicts: string[];
  aliases: string[];
  whenToUse?: string;
  allowedTools?: string[];
  userInvocable: boolean;
  context: SkillContext;
} {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatterMatch) {
    return {
      body: content,
      priority: 0,
      conflicts: [],
      aliases: [],
      userInvocable: true,
      context: "inline",
    };
  }

  const metadata = parseFrontmatter(frontmatterMatch[1]);
  const contextRaw = typeof metadata.context === "string" ? metadata.context.trim().toLowerCase() : "";
  const context: SkillContext = contextRaw === "fork" ? "fork" : "inline";
  const userInvocable = metadata["user-invocable"] !== "false" && metadata["user_invocable"] !== "false";

  let allowedTools: string[] | undefined;
  const allowedToolsRaw = metadata["allowed-tools"] ?? metadata["allowed_tools"];
  if (typeof allowedToolsRaw === "string" && allowedToolsRaw.trim()) {
    allowedTools = allowedToolsRaw
      .replace(/^\[/, "").replace(/\]$/, "")
      .split(",")
      .map((s: string) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  } else if (Array.isArray(allowedToolsRaw)) {
    allowedTools = allowedToolsRaw.filter((t): t is string => typeof t === "string" && t.trim() !== "");
  }

  const whenToUse = (metadata["when-to-use"] ?? metadata["when_to_use"]) as string | undefined;

  return {
    body: content.slice(frontmatterMatch[0].length),
    priority:
      typeof metadata.priority === "number" && Number.isFinite(metadata.priority)
        ? metadata.priority
        : 0,
    conflicts: normalizeStringList(metadata.conflicts),
    aliases: normalizeStringList(metadata.aliases),
    whenToUse: typeof whenToUse === "string" && whenToUse.trim() ? whenToUse.trim() : undefined,
    allowedTools: allowedTools && allowedTools.length > 0 ? allowedTools : undefined,
    userInvocable,
    context,
  };
}

/**
 * 函数 `parseFrontmatter` 的职责说明。
 * `parseFrontmatter` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parseFrontmatter(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();

    if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }

    const maybeNumber = Number(value);
    result[key] = Number.isFinite(maybeNumber) && value !== "" ? maybeNumber : value;
  }

  return result;
}

/**
 * 函数 `normalizeStringList` 的职责说明。
 * `normalizeStringList` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string" && value.trim() !== "") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  return [];
}

/**
 * 函数 `resolveSkillConflicts` 的职责说明。
 * `resolveSkillConflicts` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function resolveSkillConflicts(skills: SkillDefinition[]): SkillDefinition[] {
  const selected: SkillDefinition[] = [];

  for (const skill of skills) {
    const conflictsExisting = selected.some(
      (item) =>
        item.conflicts.includes(skill.name) || skill.conflicts.includes(item.name)
    );

    if (conflictsExisting) {
      continue;
    }

    selected.push(skill);
  }

  return selected;
}

const GENERIC_SKILL_TERMS = new Set([
  "skill",
  "skills",
  "agent",
  "gateway",
  "maintainer",
  "helper",
]);
