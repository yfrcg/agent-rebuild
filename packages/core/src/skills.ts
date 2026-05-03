import * as fs from "fs";
import * as path from "path";

import { ROOT_DIR, WORKSPACE_DIR } from "./config";

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
}

interface SkillSource {
  platform: string;
  root: string;
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
const DEFAULT_SKILL_SOURCES: SkillSource[] = [
  {
    platform: "workspace",
    root: path.join(WORKSPACE_DIR, "skills"),
  },
  {
    platform: "repo",
    root: path.join(ROOT_DIR, "skills"),
  },
  {
    platform: "codex",
    root: path.join(ROOT_DIR, ".codex", "skills"),
  },
  {
    platform: "trae",
    root: path.join(ROOT_DIR, ".trae", "skills"),
  },
  {
    platform: "claude",
    root: path.join(ROOT_DIR, ".claude", "skills"),
  },
];

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

function readSkillFile(source: SkillSource, filePath: string): SkillDefinition {
  const rawContent = fs.readFileSync(filePath, "utf8");
  const metadata = extractSkillMetadata(rawContent);
  const title = extractSkillTitle(metadata.body, filePath);
  const description = extractSkillDescription(metadata.body);
  const relativePath = path.relative(ROOT_DIR, filePath).replace(/\\/g, "/");
  const directoryName = path.basename(path.dirname(filePath));
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
  };
}

function extractSkillTitle(content: string, filePath: string): string {
  const lines = content.split(/\r?\n/);
  const heading = lines.find((line) => line.trim().startsWith("#"));
  if (heading) {
    return heading.replace(/^#+\s*/, "").trim();
  }

  return path.basename(path.dirname(filePath));
}

function extractSkillDescription(content: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const description = lines.find(
    (line) => line && !line.startsWith("#") && !line.startsWith("-") && !line.startsWith("*")
  );

  return description ?? "No description provided.";
}

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

function trimSkillContent(content: string): string {
  if (content.length <= MAX_SKILL_CONTENT_CHARS) {
    return content.trim();
  }

  const safeMax = MAX_SKILL_CONTENT_CHARS - 48;
  return `${content.slice(0, safeMax).trim()}\n\n[skill content truncated]`;
}

function collectExplicitMentions(userInput: string): Set<string> {
  const mentions = new Set<string>();
  const matches = userInput.match(/[@$]([A-Za-z0-9._/-]+)/g) ?? [];

  for (const match of matches) {
    mentions.add(normalizeSkillName(match.slice(1)));
  }

  return mentions;
}

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

function normalizeSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

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

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function extractSkillMetadata(content: string): {
  body: string;
  priority: number;
  conflicts: string[];
  aliases: string[];
} {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatterMatch) {
    return {
      body: content,
      priority: 0,
      conflicts: [],
      aliases: [],
    };
  }

  const metadata = parseFrontmatter(frontmatterMatch[1]);
  return {
    body: content.slice(frontmatterMatch[0].length),
    priority:
      typeof metadata.priority === "number" && Number.isFinite(metadata.priority)
        ? metadata.priority
        : 0,
    conflicts: normalizeStringList(metadata.conflicts),
    aliases: normalizeStringList(metadata.aliases),
  };
}

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

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string" && value.trim() !== "") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  return [];
}

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
