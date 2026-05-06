
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { resolveProjectRoot } from "../../core/src/config";
import { createToolSecurityProfile } from "../toolSecurityProfile";
import type { GatewayTool, GatewayToolInput, GatewayToolOutput } from "../toolTypes";

/**
 * 函数 `createAgentTools` 的职责说明。
 * `createAgentTools` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createAgentTools(projectRoot = resolveProjectRoot()): GatewayTool[] {
  return [
    createAgentVerifyTool(projectRoot),
    createPolicyCheckTool(projectRoot),
    createAuditQueryTool(projectRoot),
  ];
}

/**
 * 函数 `runGit` 的职责说明。
 * `runGit` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function runGit(args: string[], cwd: string): string {
  try {
    return execSync(`git ${args.join(" ")}`, {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    throw new Error(error.stderr?.trim() || error.message || "git command failed");
  }
}

/**
 * 函数 `createAgentVerifyTool` 的职责说明。
 * `createAgentVerifyTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createAgentVerifyTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      userGoal: {
        type: "string",
        description: "The original user goal or task description to verify against.",
      },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "Steps performed during the task.",
      },
    },
    required: ["userGoal"],
  } satisfies Record<string, unknown>;

  return {
    name: "agent.verify",
    description: "Verify current modifications against user goal. Returns pass/fail/needs_fix/uncertain, risks, failedChecks, suggestedFixes.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "execute",
    readOnly: false,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["agent", "verify", "audit"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: false,
      allowHostExecution: true,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input) {
      const userGoal = typeof input.userGoal === "string" ? input.userGoal.trim() : "";
      if (!userGoal) {
        return { ok: false, error: "userGoal must not be empty." };
      }

      const stepsPerformed = Array.isArray(input.steps)
        ? input.steps.filter((s: unknown) => typeof s === "string")
        : [];

      const checks: Array<{ check: string; passed: boolean; detail: string }> = [];
      const risks: string[] = [];
      const suggestedFixes: string[] = [];

      let changedFiles: string[] = [];
      try {
        const diffNames = runGit(["diff", "--name-only"], projectRoot);
        const stagedNames = runGit(["diff", "--cached", "--name-only"], projectRoot);
        const untracked = runGit(["ls-files", "--others", "--exclude-standard"], projectRoot);
        changedFiles = [diffNames, stagedNames, untracked]
          .filter(Boolean)
          .flatMap((s) => s.split("\n"))
          .filter(Boolean);
      } catch {
      }

      const hasChanges = changedFiles.length > 0;
      checks.push({
        check: "has_changes",
        passed: hasChanges,
        detail: hasChanges ? `${changedFiles.length} file(s) changed` : "No changes detected",
      });

      const goalLower = userGoal.toLowerCase();
      const goalWantsTest = goalLower.includes("test") || goalLower.includes("测试");
      const goalWantsFix = goalLower.includes("fix") || goalLower.includes("bug") || goalLower.includes("修复") || goalLower.includes("错误");
      const goalWantsFeature = goalLower.includes("feature") || goalLower.includes("add") || goalLower.includes("新增") || goalLower.includes("功能");
      const goalWantsRefactor = goalLower.includes("refactor") || goalLower.includes("重构");

      if (goalWantsTest) {
        const testFilesChanged = changedFiles.some((f) => f.includes("test") || f.includes("spec") || f.includes("__tests__"));
        checks.push({
          check: "test_files_changed",
          passed: testFilesChanged,
          detail: testFilesChanged ? "Test files are modified" : "No test files changed",
        });
        if (!testFilesChanged) {
          suggestedFixes.push("Add or update test files to cover the changes.");
        }
      }

      if (goalWantsFix) {
        const sourceChanged = changedFiles.some((f) => !f.includes("test") && !f.includes("spec"));
        checks.push({
          check: "source_files_changed",
          passed: sourceChanged,
          detail: sourceChanged ? "Source files are modified" : "No source files changed (only tests?)",
        });
      }

      if (goalWantsFeature || goalWantsRefactor) {
        const readmeChanged = changedFiles.some((f) => f.toLowerCase().includes("readme"));
        if (readmeChanged) {
          checks.push({
            check: "readme_updated",
            passed: true,
            detail: "README updated",
          });
        }
      }

      const configFiles = changedFiles.filter((f) =>
        f.includes(".env") || f.includes("config") || f.includes("tsconfig")
      );
      if (configFiles.length > 0) {
        risks.push(`Configuration files changed: ${configFiles.join(", ")}`);
      }

      let verdict: "pass" | "fail" | "needs_fix" | "uncertain";
      const failedChecks = checks.filter((c) => !c.passed);

      if (failedChecks.length === 0 && hasChanges) {
        verdict = "pass";
      } else if (failedChecks.length === 0 && !hasChanges) {
        verdict = "uncertain";
      } else if (failedChecks.some((c) => c.check === "has_changes")) {
        verdict = "fail";
      } else {
        verdict = "needs_fix";
      }

      return {
        ok: true,
        content: {
          verdict,
          userGoal,
          stepsPerformed,
          checks,
          failedChecks: failedChecks.map((c) => ({ check: c.check, detail: c.detail })),
          risks,
          suggestedFixes,
          changedFiles,
          summary: `Verdict: ${verdict}. ${checks.length} checks run, ${failedChecks.length} failed.`,
        },
        metadata: { verdict, failedChecks: failedChecks.length },
      };
    },
  };
}

/**
 * 函数 `createPolicyCheckTool` 的职责说明。
 * `createPolicyCheckTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createPolicyCheckTool(_projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      toolName: {
        type: "string",
        description: "Name of the tool to check.",
      },
      args: {
        type: "object",
        description: "Arguments to check against policy.",
      },
    },
    required: ["toolName", "args"],
  } satisfies Record<string, unknown>;

  const DANGEROUS_PATTERNS = [
    { pattern: /\brm\s+-rf\b/i, reason: "Recursive force delete (rm -rf)" },
    { pattern: /\brmdir\s+\/s\b/i, reason: "Recursive directory delete (rmdir /s)" },
    { pattern: /~\/\.ssh/i, reason: "Access to SSH keys directory" },
    { pattern: /\.ssh\b/i, reason: "Access to SSH directory" },
    { pattern: /\.env\b/i, reason: "Access to .env file (may contain secrets)" },
    { pattern: /\bcurl\b.*\|\s*(ba)?sh/i, reason: "Pipe curl to shell (remote code execution)" },
    { pattern: /\bwget\b.*\|\s*(ba)?sh/i, reason: "Pipe wget to shell (remote code execution)" },
    { pattern: /\bpowershell\b.*\b(iex|invoke-expression)\b/i, reason: "PowerShell dynamic code execution" },
    { pattern: /\bInvoke-WebRequest\b.*\b(iex|Invoke-Expression)\b/i, reason: "PowerShell download and execute" },
    { pattern: /\bStart-BitsTransfer\b/i, reason: "PowerShell file download" },
    { pattern: /\b(New-Object\s+Net\.WebClient)\b/i, reason: "PowerShell web client download" },
    { pattern: /\bDownloadString\b/i, reason: "Remote string download" },
    { pattern: /\bDownloadFile\b/i, reason: "Remote file download" },
    { pattern: /\bformat-disk\b/i, reason: "Disk formatting command" },
    { pattern: /\bshutdown\b/i, reason: "System shutdown command" },
    { pattern: /\breboot\b/i, reason: "System reboot command" },
    { pattern: /\breg\s+delete\b/i, reason: "Registry deletion" },
    { pattern: /\bnet\s+user\b.*\b(add|delete)\b/i, reason: "User account modification" },
  ];

  return {
    name: "policy.check",
    description: "Check if a tool call is safe. Returns allowed/denied/warn with reasons. Focuses on shell.run dangerous commands.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["policy", "security", "check"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input) {
      const toolName = typeof input.toolName === "string" ? input.toolName.trim() : "";
      const args = input.args && typeof input.args === "object" ? input.args as Record<string, unknown> : {};

      if (!toolName) {
        return { ok: false, error: "toolName must not be empty." };
      }

      const violations: Array<{ rule: string; severity: "block" | "warn"; detail: string }> = [];

      const shellTools = new Set(["shell.run", "bash.run", "run_test", "npm_test", "build"]);
      if (shellTools.has(toolName)) {
        const cmd = typeof args.command === "string" ? args.command : "";
        const cmdLine = typeof args.cmdLine === "string" ? args.cmdLine : "";
        const fullCmd = `${cmd} ${cmdLine}`.trim();

        if (fullCmd) {
          for (const { pattern, reason } of DANGEROUS_PATTERNS) {
            if (pattern.test(fullCmd)) {
              violations.push({
                rule: pattern.source,
                severity: reason.includes("remote code") || reason.includes("delete") || reason.includes("code execution") || reason.includes("download and execute") ? "block" : "warn",
                detail: reason,
              });
            }
          }
        }

        const cwd = typeof args.cwd === "string" ? args.cwd : "";
        if (cwd) {
          const normalizedCwd = cwd.replace(/\\/g, "/");
          const outsidePatterns = [
            /^[a-z]:\/windows/i,
            /^\/(etc|usr|bin|sbin|var|root)/i,
            /program\s*files/i,
          ];
          for (const p of outsidePatterns) {
            if (p.test(normalizedCwd)) {
              violations.push({
                rule: "workspace_outside",
                severity: "block",
                detail: `cwd appears to be outside workspace: ${cwd}`,
              });
            }
          }
        }
      }

      const fileTools = new Set(["file.read", "file.write", "file.edit", "file.multi_edit", "file.patch"]);
      if (fileTools.has(toolName)) {
        const filePath = typeof args.path === "string" ? args.path : "";
        if (filePath) {
          const sensitive = [".env", ".ssh", "id_rsa", "id_ed25519", ".pem", ".key"];
          for (const s of sensitive) {
            if (filePath.toLowerCase().includes(s)) {
              violations.push({
                rule: "sensitive_file",
                severity: "warn",
                detail: `Access to potentially sensitive file: ${filePath}`,
              });
            }
          }
        }
      }

      const hasBlock = violations.some((v) => v.severity === "block");
      const verdict = hasBlock ? "denied" : violations.length > 0 ? "warn" : "allowed";

      return {
        ok: true,
        content: {
          toolName,
          verdict,
          violations,
          summary: verdict === "allowed"
            ? "No policy violations detected."
            : `${violations.length} violation(s): ${violations.map((v) => v.detail).join("; ")}`,
        },
        metadata: { verdict, violations: violations.length },
      };
    },
  };
}

/**
 * 函数 `createAuditQueryTool` 的职责说明。
 * `createAuditQueryTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createAuditQueryTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Number of recent entries to return (default 20, max 100).",
      },
      toolName: {
        type: "string",
        description: "Filter by tool name.",
      },
      riskLevel: {
        type: "string",
        description: "Filter by risk level (safe, low, medium, dangerous).",
      },
      failedOnly: {
        type: "boolean",
        description: "Only return failed calls (default: false).",
      },
    },
  } satisfies Record<string, unknown>;

  return {
    name: "audit.query",
    description: "Query recent audit log entries. Returns tool calls, duration, success/failure, risk level. Does not expose sensitive argument details.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["audit", "log", "query", "read"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input) {
      const limit = clampNumber(input.limit, 20, 1, 100);
      const toolFilter = typeof input.toolName === "string" ? input.toolName.trim() : undefined;
      const riskFilter = typeof input.riskLevel === "string" ? input.riskLevel.trim() : undefined;
      const failedOnly = input.failedOnly === true;

      const auditPath = path.join(projectRoot, "logs", "audit", "gateway-audit.jsonl");

      let lines: string[];
      try {
        const content = fs.readFileSync(auditPath, "utf8");
        lines = content.split("\n").filter((l) => l.trim());
      } catch {
        return {
          ok: true,
          content: {
            entries: [],
            totalEntries: 0,
            returned: 0,
            auditPath,
            note: "Audit log file not found or empty.",
          },
          metadata: { totalEntries: 0 },
        };
      }

      const entries: Array<Record<string, unknown>> = [];

      for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;

          const sanitized: Record<string, unknown> = {
            toolName: entry.toolName,
            riskLevel: entry.riskLevel,
            ok: entry.ok,
            durationMs: entry.durationMs,
            reason: entry.reason,
            sessionRef: entry.sessionRef,
            createdAt: entry.createdAt,
          };

          if (entry.args && typeof entry.args === "object") {
            const args = entry.args as Record<string, unknown>;
            const safeArgs: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(args)) {
              if (typeof value === "string" && value.length > 100) {
                safeArgs[key] = `[string, ${value.length} chars]`;
              } else if (key.toLowerCase().includes("key") || key.toLowerCase().includes("token") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("password")) {
                safeArgs[key] = "[REDACTED]";
              } else {
                safeArgs[key] = value;
              }
            }
            sanitized.args = safeArgs;
          }

          if (toolFilter && sanitized.toolName !== toolFilter) continue;
          if (riskFilter && sanitized.riskLevel !== riskFilter) continue;
          if (failedOnly && sanitized.ok === true) continue;

          entries.push(sanitized);
        } catch {
        }
      }

      return {
        ok: true,
        content: {
          entries,
          totalEntries: lines.length,
          returned: entries.length,
          filters: {
            toolName: toolFilter ?? null,
            riskLevel: riskFilter ?? null,
            failedOnly,
          },
        },
        metadata: { totalEntries: lines.length, returned: entries.length },
      };
    },
  };
}

/**
 * 函数 `clampNumber` 的职责说明。
 * `clampNumber` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function clampNumber(value: unknown, defaultVal: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultVal;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
