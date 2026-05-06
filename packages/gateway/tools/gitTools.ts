
import { execSync } from "node:child_process";
import * as path from "node:path";

import { resolveProjectRoot } from "../../core/src/config";
import { createToolSecurityProfile } from "../toolSecurityProfile";
import type { GatewayTool, GatewayToolInput, GatewayToolOutput } from "../toolTypes";

/**
 * 函数 `createGitTools` 的职责说明。
 * `createGitTools` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createGitTools(projectRoot = resolveProjectRoot()): GatewayTool[] {
  return [
    createGitStatusTool(projectRoot),
    createGitDiffTool(projectRoot),
    createGitCommitTool(projectRoot),
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
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    throw new Error(error.stderr?.trim() || error.message || "git command failed");
  }
}

/**
 * 函数 `createGitStatusTool` 的职责说明。
 * `createGitStatusTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createGitStatusTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {},
  } satisfies Record<string, unknown>;

  return {
    name: "git.status",
    description: "Get git status: changed files, untracked files, staged files, clean flag.",
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
      tags: ["git", "status", "read"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke() {
      const output = runGit(["status", "--porcelain=v1"], projectRoot);
      const lines = output ? output.split("\n") : [];

      const changedFiles: string[] = [];
      const untrackedFiles: string[] = [];
      const stagedFiles: string[] = [];

      for (const line of lines) {
        if (line.length < 4) continue;
        const indexStatus = line[0];
        const workTreeStatus = line[1];
        const filePath = line.slice(3);

        if (indexStatus === "?") {
          untrackedFiles.push(filePath);
        } else {
          if (indexStatus !== " " && indexStatus !== "?") {
            stagedFiles.push(filePath);
          }
          if (workTreeStatus !== " " && workTreeStatus !== "?") {
            changedFiles.push(filePath);
          }
        }
      }

      return {
        ok: true,
        content: {
          changedFiles,
          untrackedFiles,
          stagedFiles,
          clean: lines.length === 0,
          totalChanges: lines.length,
        },
        metadata: { totalChanges: lines.length },
      };
    },
  };
}

/**
 * 函数 `createGitDiffTool` 的职责说明。
 * `createGitDiffTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createGitDiffTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Specific file path to diff (default: all files).",
      },
      staged: {
        type: "boolean",
        description: "Show staged changes instead of working directory (default: false).",
      },
      maxChars: {
        type: "number",
        description: "Maximum characters in diff preview (default 8000, max 30000).",
      },
    },
  } satisfies Record<string, unknown>;

  return {
    name: "git.diff",
    description: "Get git diff: summary, files, diffPreview, truncated flag.",
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
      tags: ["git", "diff", "read"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input) {
      const filePath = typeof input.path === "string" ? input.path : undefined;
      const staged = input.staged === true;
      const maxChars = clampNumber(input.maxChars, 8000, 1000, 30000);

      const args = ["diff", "--stat", "--stat-width=200"];
      if (staged) args.push("--cached");
      if (filePath) args.push("--", filePath);

      let summary: string;
      try {
        summary = runGit(args, projectRoot);
      } catch {
        summary = "";
      }

      const diffArgs = ["diff"];
      if (staged) diffArgs.push("--cached");
      if (filePath) diffArgs.push("--", filePath);

      let diffRaw: string;
      try {
        diffRaw = runGit(diffArgs, projectRoot);
      } catch {
        diffRaw = "";
      }

      const diffPreview = diffRaw.slice(0, maxChars);
      const truncated = diffRaw.length > maxChars;

      const filesChanged: string[] = [];
      const fileRegex = /^diff --git a\/(.+?) b\//gm;
      let match: RegExpExecArray | null;
      while ((match = fileRegex.exec(diffRaw)) !== null) {
        filesChanged.push(match[1]);
      }

      return {
        ok: true,
        content: {
          summary: summary || "(no changes)",
          files: filesChanged,
          diffPreview,
          truncated,
          charsTotal: diffRaw.length,
        },
        metadata: { filesChanged: filesChanged.length, charsTotal: diffRaw.length },
      };
    },
  };
}

/**
 * 函数 `createGitCommitTool` 的职责说明。
 * `createGitCommitTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createGitCommitTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Commit message (required, non-empty).",
      },
      addAll: {
        type: "boolean",
        description: "Stage all changes before commit (default: false).",
      },
    },
    required: ["message"],
  } satisfies Record<string, unknown>;

  return {
    name: "git.commit",
    description: "Create a git commit. Does NOT push. Requires a non-empty message. Fails if no changes.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    policy: {
      automationLevel: "confirm",
      riskLevel: "stateful",
      tags: ["git", "commit", "write"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: true,
      allowHostExecution: true,
      requireApproval: false,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input) {
      const message = typeof input.message === "string" ? input.message.trim() : "";
      if (!message) {
        return { ok: false, error: "Commit message must not be empty." };
      }

      if (input.addAll === true) {
        runGit(["add", "-A"], projectRoot);
      }

      const status = runGit(["status", "--porcelain=v1"], projectRoot);
      if (!status) {
        return { ok: false, error: "No changes to commit." };
      }

      const commitOutput = runGit(["commit", "-m", message], projectRoot);

      const hashOutput = runGit(["rev-parse", "--short", "HEAD"], projectRoot);

      return {
        ok: true,
        content: {
          message,
          commitHash: hashOutput,
          output: commitOutput,
        },
        metadata: { commitHash: hashOutput },
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
