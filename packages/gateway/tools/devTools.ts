/**
 * ?????CS336 ???
 * ???packages/gateway/tools/devTools.ts
 * ??????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveProjectRoot } from "../../core/src/config";
import { createToolSecurityProfile } from "../toolSecurityProfile";
import type { GatewayTool, GatewayToolInput, GatewayToolOutput } from "../toolTypes";

/**
 * 函数 `createDevTools` 的职责说明。
 * `createDevTools` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createDevTools(projectRoot = resolveProjectRoot()): GatewayTool[] {
  return [
    createTypecheckTool(projectRoot),
    createLintTool(projectRoot),
    createVerifyTool(projectRoot),
  ];
}

/**
 * 函数 `readPackageJsonScripts` 的职责说明。
 * `readPackageJsonScripts` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function readPackageJsonScripts(projectRoot: string): Record<string, string> {
  try {
    const content = fs.readFileSync(path.join(projectRoot, "package.json"), "utf8");
    const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * 函数 `runCommand` 的职责说明。
 * `runCommand` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function runCommand(cmd: string, cwd: string, timeoutMs = 60000): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    return {
      stdout: (error.stdout ?? "").trim(),
      stderr: (error.stderr ?? "").trim(),
      exitCode: error.status ?? 1,
    };
  }
}

/**
 * 函数 `createTypecheckTool` 的职责说明。
 * `createTypecheckTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createTypecheckTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {},
  } satisfies Record<string, unknown>;

  return {
    name: "typecheck.run",
    description: "Run TypeScript type check. Uses npm script 'typecheck' if available, otherwise 'npx tsc --noEmit'.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "execute",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["dev", "typecheck", "typescript"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: false,
      allowHostExecution: true,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke() {
      const scripts = readPackageJsonScripts(projectRoot);
      const cmd = scripts.typecheck ? "npm run typecheck" : "npx tsc --noEmit";
      const result = runCommand(cmd, projectRoot, 60000);

      return {
        ok: result.exitCode === 0,
        content: {
          command: cmd,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 8000),
          stderr: result.stderr.slice(0, 4000),
        },
        error: result.exitCode !== 0 ? `Typecheck failed (exit ${result.exitCode})` : undefined,
        metadata: { exitCode: result.exitCode },
      };
    },
  };
}

/**
 * 函数 `createLintTool` 的职责说明。
 * `createLintTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createLintTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {},
  } satisfies Record<string, unknown>;

  return {
    name: "lint.run",
    description: "Run linting. Uses npm script 'lint' if available, otherwise skipped (not a failure).",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "execute",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["dev", "lint"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: false,
      allowHostExecution: true,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke() {
      const scripts = readPackageJsonScripts(projectRoot);

      if (!scripts.lint) {
        return {
          ok: true,
          content: {
            command: "(skipped)",
            skipped: true,
            reason: "No 'lint' script in package.json",
          },
          metadata: { skipped: true },
        };
      }

      const result = runCommand("npm run lint", projectRoot, 60000);

      return {
        ok: result.exitCode === 0,
        content: {
          command: "npm run lint",
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 8000),
          stderr: result.stderr.slice(0, 4000),
          skipped: false,
        },
        error: result.exitCode !== 0 ? `Lint failed (exit ${result.exitCode})` : undefined,
        metadata: { exitCode: result.exitCode },
      };
    },
  };
}

/**
 * 函数 `createVerifyTool` 的职责说明。
 * `createVerifyTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createVerifyTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      skipSteps: {
        type: "array",
        items: { type: "string" },
        description: "Steps to skip: 'typecheck', 'lint', 'build', 'test', 'git_diff'.",
      },
    },
  } satisfies Record<string, unknown>;

    interface VerifyStepResult {
    step: string;
    ok: boolean;
    skipped: boolean;
    exitCode?: number;
    durationMs: number;
    output?: string;
    error?: string;
  }

  return {
    name: "verify.run",
    description: "Run full verification: typecheck, lint, build, test, git_diff. Returns structured steps, changedFiles, summary, suggestedNextAction.",
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
      tags: ["dev", "verify", "ci"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: false,
      allowHostExecution: true,
    }),
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input) {
      const skipSteps = new Set(
        Array.isArray(input.skipSteps)
          ? input.skipSteps.filter((s: unknown) => typeof s === "string")
          : []
      );

      const scripts = readPackageJsonScripts(projectRoot);
      const steps: VerifyStepResult[] = [];
      let allOk = true;

      /**
       * 函数 `runStep` 的职责说明。
       * `runStep` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
       * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
       */
      async function runStep(name: string, cmd: string | null) {
        if (skipSteps.has(name)) {
          steps.push({ step: name, ok: true, skipped: true, durationMs: 0 });
          return;
        }
        if (!cmd) {
          steps.push({ step: name, ok: true, skipped: true, durationMs: 0, output: "No script found" });
          return;
        }

        const start = Date.now();
        const result = runCommand(cmd, projectRoot, 120000);
        const durationMs = Date.now() - start;

        const stepOk = result.exitCode === 0;
        if (!stepOk) allOk = false;

        steps.push({
          step: name,
          ok: stepOk,
          skipped: false,
          exitCode: result.exitCode,
          durationMs,
          output: result.stdout.slice(0, 3000),
          error: result.stderr ? result.stderr.slice(0, 2000) : undefined,
        });
      }

      await runStep("typecheck", scripts.typecheck ? "npm run typecheck" : "npx tsc --noEmit");
      await runStep("lint", scripts.lint ? "npm run lint" : null);
      await runStep("build", scripts.build ? "npm run build" : null);
      await runStep("test", scripts.test ? "npm test" : null);

      let changedFiles: string[] = [];
      if (!skipSteps.has("git_diff")) {
        const start = Date.now();
        try {
          const diffStat = runGit(["diff", "--name-only"], projectRoot);
          const staged = runGit(["diff", "--cached", "--name-only"], projectRoot);
          const untracked = runGit(["ls-files", "--others", "--exclude-standard"], projectRoot);
          changedFiles = [diffStat, staged, untracked]
            .filter(Boolean)
            .flatMap((s) => s.split("\n"))
            .filter(Boolean);
          steps.push({
            step: "git_diff",
            ok: true,
            skipped: false,
            durationMs: Date.now() - start,
            output: `${changedFiles.length} file(s) changed`,
          });
        } catch {
          steps.push({
            step: "git_diff",
            ok: false,
            skipped: false,
            durationMs: Date.now() - start,
            error: "git diff failed",
          });
          allOk = false;
        }
      }

      const failedSteps = steps.filter((s) => !s.ok && !s.skipped);
      let suggestedNextAction = "All checks passed. Ready to commit.";
      if (failedSteps.length > 0) {
        suggestedNextAction = `Fix failing steps: ${failedSteps.map((s) => s.step).join(", ")}`;
      } else if (changedFiles.length > 0) {
        suggestedNextAction = "Checks passed but files are changed. Consider committing.";
      }

      return {
        ok: allOk,
        content: {
          steps,
          changedFiles,
          summary: allOk
            ? `All ${steps.filter((s) => !s.skipped).length} checks passed.`
            : `${failedSteps.length} check(s) failed: ${failedSteps.map((s) => s.step).join(", ")}`,
          suggestedNextAction,
        },
        error: allOk ? undefined : `${failedSteps.length} check(s) failed`,
        metadata: { failedSteps: failedSteps.length, changedFiles: changedFiles.length },
      };
    },
  };
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
