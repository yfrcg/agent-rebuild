import * as fs from "node:fs";
import * as path from "node:path";
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

function sanitizeText(text: string): string {
  let cleaned = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "[REDACTED]");
  }
  return cleaned;
}

function truncateLine(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    }
  } catch { /* corrupt file, return fallback */ }
  return fallback;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export class SessionMemoryManager {
  private sessionDir: string;

  constructor(sessionId: string, baseDir?: string) {
    if (baseDir) {
      this.sessionDir = path.join(baseDir, "sessions", sessionId);
    } else {
      this.sessionDir = resolveWorkspacePath("sessions", sessionId);
    }
    ensureDir(this.sessionDir);
  }

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

  readWorkingMemory(): WorkingMemory {
    return readJsonSafe<WorkingMemory>(this.workingMemoryPath(), this.emptyWorkingMemory());
  }

  writeWorkingMemory(wm: WorkingMemory): void {
    wm.updatedAt = nowIso();
    writeJson(this.workingMemoryPath(), wm);
  }

  readRollingSummary(): string {
    try {
      if (fs.existsSync(this.rollingSummaryPath())) {
        return fs.readFileSync(this.rollingSummaryPath(), "utf8");
      }
    } catch { /* ignore */ }
    return "# Session Rolling Summary\n\nNo activity yet.\n";
  }

  writeRollingSummary(content: string): void {
    fs.writeFileSync(this.rollingSummaryPath(), sanitizeText(content), "utf8");
  }

  readOpenIssues(): OpenIssue[] {
    return readJsonSafe<OpenIssue[]>(this.openIssuesPath(), []);
  }

  writeOpenIssues(issues: OpenIssue[]): void {
    writeJson(this.openIssuesPath(), issues);
  }

  appendDecision(decision: Decision): void {
    const line = JSON.stringify({ ...decision, timestamp: decision.timestamp || nowIso() }) + "\n";
    fs.appendFileSync(this.decisionsPath(), line, "utf8");
  }

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

  setProjectDir(projectDir: string): void {
    const wm = this.readWorkingMemory();
    wm.projectDir = projectDir;
    this.writeWorkingMemory(wm);
  }

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
            id: `issue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

  buildRollingSummarySection(): string {
    const content = this.readRollingSummary();
    if (!content || content.includes("No activity yet")) {
      return "";
    }
    return `## Session Rolling Summary\n\n${content}`;
  }

  private workingMemoryPath(): string {
    return path.join(this.sessionDir, "working-memory.json");
  }

  private rollingSummaryPath(): string {
    return path.join(this.sessionDir, "rolling-summary.md");
  }

  private openIssuesPath(): string {
    return path.join(this.sessionDir, "open-issues.json");
  }

  private decisionsPath(): string {
    return path.join(this.sessionDir, "decisions.jsonl");
  }

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
