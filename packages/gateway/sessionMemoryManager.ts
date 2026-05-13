/**
 * ?????CS336 ???
 * ???packages/gateway/sessionMemoryManager.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveWorkspacePath } from "../core/src/config";

export interface WorkingMemory {
  sessionGoal: string;
  projectDir: string;
  currentPlan: string[];
  userConstraints: string[];
  importantFacts: string[];
  filesTouched: string[];
  commandsRun: string[];
  lastKnownFailures: string[];
  openIssues: string[];
  nextActions: string[];
  updatedAt: string;
}

export interface OpenIssue {
  id: string;
  description: string;
  source: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface Decision {
  decision: string;
  reason: string;
  timestamp: string;
}

export interface SessionMemoryPatch {
  goal?: string;
  constraints?: string[];
  facts?: string[];
  filesTouched?: string[];
  commandsRun?: string[];
  failures?: string[];
  nextActions?: string[];
  issues?: string[];
  decisions?: Decision[];
  rollingSummary?: string;
}

const SENSITIVE_PATTERNS = [
  /(?:password|passwd|secret|token|api[_-]?key|credential)\s*[:=]\s*\S+/gi,
  /(?:Bearer|Basic)\s+\S+/gi,
  /[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g,
];

/**
 * 函数 `sanitizeText` 的职责说明。
 * `sanitizeText` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function sanitizeText(text: string): string {
  let cleaned = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "[REDACTED]");
  }
  return cleaned;
}

/**
 * 函数 `truncateLine` 的职责说明。
 * `truncateLine` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function truncateLine(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

/**
 * 函数 `nowIso` 的职责说明。
 * `nowIso` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 函数 `ensureDir` 的职责说明。
 * `ensureDir` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 函数 `readJsonSafe` 的职责说明。
 * `readJsonSafe` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    }
  } catch { /* corrupt file, return fallback */ }
  return fallback;
}

/**
 * 函数 `writeJson` 的职责说明。
 * `writeJson` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export class SessionMemoryManager {
  private sessionDir: string;

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(sessionId: string, baseDir?: string) {
    if (baseDir) {
      this.sessionDir = path.join(baseDir, "sessions", sessionId);
    } else {
      this.sessionDir = resolveWorkspacePath("sessions", sessionId);
    }
    ensureDir(this.sessionDir);
  }

  /**
   * 方法 `init` 的职责说明。
   * `init` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  init(): void {
    const wmPath = this.workingMemoryPath();
    if (!fs.existsSync(wmPath)) {
      writeJson(wmPath, this.emptyWorkingMemory());
    }

    const rsPath = this.rollingSummaryPath();
    if (!fs.existsSync(rsPath)) {
      fs.writeFileSync(rsPath, "# Session Rolling Summary\n\nNo activity yet.\n", "utf8");
    }

    const oiPath = this.openIssuesPath();
    if (!fs.existsSync(oiPath)) {
      writeJson(oiPath, []);
    }

    const decPath = this.decisionsPath();
    if (!fs.existsSync(decPath)) {
      fs.writeFileSync(decPath, "", "utf8");
    }
  }

  /**
   * 方法 `readWorkingMemory` 的职责说明。
   * `readWorkingMemory` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  readWorkingMemory(): WorkingMemory {
    return readJsonSafe<WorkingMemory>(this.workingMemoryPath(), this.emptyWorkingMemory());
  }

  /**
   * 方法 `writeWorkingMemory` 的职责说明。
   * `writeWorkingMemory` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  writeWorkingMemory(wm: WorkingMemory): void {
    wm.updatedAt = nowIso();
    writeJson(this.workingMemoryPath(), wm);
  }

  /**
   * 方法 `readRollingSummary` 的职责说明。
   * `readRollingSummary` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  readRollingSummary(): string {
    try {
      if (fs.existsSync(this.rollingSummaryPath())) {
        return fs.readFileSync(this.rollingSummaryPath(), "utf8");
      }
    } catch { /* ignore */ }
    return "# Session Rolling Summary\n\nNo activity yet.\n";
  }

  /**
   * 方法 `writeRollingSummary` 的职责说明。
   * `writeRollingSummary` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  writeRollingSummary(content: string): void {
    fs.writeFileSync(this.rollingSummaryPath(), sanitizeText(content), "utf8");
  }

  /**
   * 方法 `readOpenIssues` 的职责说明。
   * `readOpenIssues` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  readOpenIssues(): OpenIssue[] {
    return readJsonSafe<OpenIssue[]>(this.openIssuesPath(), []);
  }

  /**
   * 方法 `writeOpenIssues` 的职责说明。
   * `writeOpenIssues` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  writeOpenIssues(issues: OpenIssue[]): void {
    writeJson(this.openIssuesPath(), issues);
  }

  /**
   * 方法 `appendDecision` 的职责说明。
   * `appendDecision` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  appendDecision(decision: Decision): void {
    const line = JSON.stringify({ ...decision, timestamp: decision.timestamp || nowIso() }) + "\n";
    fs.appendFileSync(this.decisionsPath(), line, "utf8");
  }

  /**
   * 方法 `readDecisions` 的职责说明。
   * `readDecisions` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  readDecisions(): Decision[] {
    try {
      if (!fs.existsSync(this.decisionsPath())) return [];
      return fs
        .readFileSync(this.decisionsPath(), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) as Decision; } catch { return null; }
        })
        .filter((d): d is Decision => d !== null);
    } catch { return []; }
  }

  /**
   * 方法 `setProjectDir` 的职责说明。
   * `setProjectDir` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  setProjectDir(projectDir: string): void {
    const wm = this.readWorkingMemory();
    wm.projectDir = projectDir;
    this.writeWorkingMemory(wm);
  }

  /**
   * 方法 `applyPatch` 的职责说明。
   * `applyPatch` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  applyPatch(patch: SessionMemoryPatch): void {
    const wm = this.readWorkingMemory();

    if (patch.goal) {
      wm.sessionGoal = sanitizeText(patch.goal);
    }

    if (patch.constraints) {
      const existing = new Set(wm.userConstraints);
      for (const c of patch.constraints) {
        const clean = sanitizeText(truncateLine(c, 300));
        if (clean && !existing.has(clean)) {
          wm.userConstraints.push(clean);
          existing.add(clean);
        }
      }
      if (wm.userConstraints.length > 20) {
        wm.userConstraints = wm.userConstraints.slice(-20);
      }
    }

    if (patch.facts) {
      const existing = new Set(wm.importantFacts);
      for (const f of patch.facts) {
        const clean = sanitizeText(truncateLine(f, 300));
        if (clean && !existing.has(clean)) {
          wm.importantFacts.push(clean);
          existing.add(clean);
        }
      }
      if (wm.importantFacts.length > 30) {
        wm.importantFacts = wm.importantFacts.slice(-30);
      }
    }

    if (patch.filesTouched) {
      const existing = new Set(wm.filesTouched);
      for (const f of patch.filesTouched) {
        if (!existing.has(f)) {
          wm.filesTouched.push(f);
          existing.add(f);
        }
      }
      if (wm.filesTouched.length > 50) {
        wm.filesTouched = wm.filesTouched.slice(-50);
      }
    }

    if (patch.commandsRun) {
      const existing = new Set(wm.commandsRun);
      for (const c of patch.commandsRun) {
        const clean = truncateLine(c, 200);
        if (clean && !existing.has(clean)) {
          wm.commandsRun.push(clean);
          existing.add(clean);
        }
      }
      if (wm.commandsRun.length > 30) {
        wm.commandsRun = wm.commandsRun.slice(-30);
      }
    }

    if (patch.failures) {
      wm.lastKnownFailures = patch.failures
        .map((f) => sanitizeText(truncateLine(f, 300)))
        .filter(Boolean)
        .slice(-5);
    }

    if (patch.nextActions) {
      wm.nextActions = patch.nextActions
        .map((a) => sanitizeText(truncateLine(a, 200)))
        .filter(Boolean)
        .slice(-10);
    }

    if (patch.issues) {
      const issues = this.readOpenIssues();
      const existingDescs = new Set(issues.filter((i) => !i.resolvedAt).map((i) => i.description));
      for (const desc of patch.issues) {
        const clean = sanitizeText(truncateLine(desc, 300));
        if (clean && !existingDescs.has(clean)) {
          issues.push({
            id: `issue-${Date.now()}-${randomBytes(6).toString("hex")}`,
            description: clean,
            source: "auto",
            createdAt: nowIso(),
          });
          existingDescs.add(clean);
        }
      }
      this.writeOpenIssues(issues);
      wm.openIssues = issues.filter((i) => !i.resolvedAt).map((i) => i.description);
    }

    if (patch.decisions) {
      for (const d of patch.decisions) {
        this.appendDecision({
          decision: sanitizeText(truncateLine(d.decision, 300)),
          reason: sanitizeText(truncateLine(d.reason, 300)),
          timestamp: d.timestamp || nowIso(),
        });
      }
    }

    this.writeWorkingMemory(wm);

    if (patch.rollingSummary) {
      this.writeRollingSummary(patch.rollingSummary);
    }
  }

  /**
   * 方法 `buildWorkingMemorySummary` 的职责说明。
   * `buildWorkingMemorySummary` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  buildWorkingMemorySummary(): string {
    const wm = this.readWorkingMemory();
    const parts: string[] = [];

    parts.push("## Session Working Memory");
    if (wm.sessionGoal) parts.push(`Goal: ${wm.sessionGoal}`);
    if (wm.projectDir) parts.push(`Project: ${wm.projectDir}`);

    if (wm.currentPlan.length > 0) {
      parts.push(`Plan: ${wm.currentPlan.join(" → ")}`);
    }

    if (wm.userConstraints.length > 0) {
      parts.push("Constraints:");
      for (const c of wm.userConstraints.slice(-5)) {
        parts.push(`  - ${c}`);
      }
    }

    if (wm.lastKnownFailures.length > 0) {
      parts.push("Known failures:");
      for (const f of wm.lastKnownFailures.slice(-3)) {
        parts.push(`  - ${f}`);
      }
    }

    if (wm.nextActions.length > 0) {
      parts.push("Next actions:");
      for (const a of wm.nextActions.slice(-5)) {
        parts.push(`  - ${a}`);
      }
    }

    if (wm.filesTouched.length > 0) {
      parts.push(`Files touched (recent): ${wm.filesTouched.slice(-10).join(", ")}`);
    }

    if (wm.openIssues.length > 0) {
      parts.push("Open issues:");
      for (const i of wm.openIssues.slice(-5)) {
        parts.push(`  - ${i}`);
      }
    }

    return parts.join("\n");
  }

  /**
   * 方法 `buildRollingSummarySection` 的职责说明。
   * `buildRollingSummarySection` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  buildRollingSummarySection(): string {
    const content = this.readRollingSummary();
    if (!content || content.includes("No activity yet")) {
      return "";
    }
    return `## Session Rolling Summary\n\n${content}`;
  }

  /**
   * 方法 `workingMemoryPath` 的职责说明。
   * `workingMemoryPath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private workingMemoryPath(): string {
    return path.join(this.sessionDir, "working-memory.json");
  }

  /**
   * 方法 `rollingSummaryPath` 的职责说明。
   * `rollingSummaryPath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private rollingSummaryPath(): string {
    return path.join(this.sessionDir, "rolling-summary.md");
  }

  /**
   * 方法 `openIssuesPath` 的职责说明。
   * `openIssuesPath` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private openIssuesPath(): string {
    return path.join(this.sessionDir, "open-issues.json");
  }

  /**
   * 方法 `decisionsPath` 的职责说明。
   * `decisionsPath` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private decisionsPath(): string {
    return path.join(this.sessionDir, "decisions.jsonl");
  }

  /**
   * 方法 `emptyWorkingMemory` 的职责说明。
   * `emptyWorkingMemory` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private emptyWorkingMemory(): WorkingMemory {
    return {
      sessionGoal: "",
      projectDir: "",
      currentPlan: [],
      userConstraints: [],
      importantFacts: [],
      filesTouched: [],
      commandsRun: [],
      lastKnownFailures: [],
      openIssues: [],
      nextActions: [],
      updatedAt: nowIso(),
    };
  }
}
