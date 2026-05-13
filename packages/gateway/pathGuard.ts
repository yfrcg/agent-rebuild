/**
 * ?????CS336 ???
 * ???packages/gateway/pathGuard.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

const DANGEROUS_PATHS = [
  "C:\\Windows",
  "C:\\Windows\\System32",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
];

const DANGEROUS_HOME_SEGMENTS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".docker",
  ".npm",
  ".config",
];

/**
 * 函数 `normalizeSafePath` 的职责说明。
 * `normalizeSafePath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function normalizeSafePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    throw new Error("[guard] path is empty");
  }

  return path.normalize(expandTilde(trimmed));
}

/**
 * 函数 `assertInsideWorkspace` 的职责说明。
 * `assertInsideWorkspace` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function assertInsideWorkspace(targetPath: string, workspaceRoot: string): void {
  const targetResolved = path.resolve(normalizeSafePath(targetPath));
  const workspaceResolved = path.resolve(normalizeSafePath(workspaceRoot));
  const relative = path.relative(workspaceResolved, targetResolved);

  if (relative === "" || relative === ".") {
    return;
  }

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`[guard] path escapes workspace: ${targetPath}`);
  }
}

/**
 * 函数 `isDangerousHostPath` 的职责说明。
 * `isDangerousHostPath` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function isDangerousHostPath(candidatePath: string): boolean {
  const normalized = normalizeForComparison(path.resolve(normalizeSafePath(candidatePath)));
  const homeDir = normalizeForComparison(path.resolve(expandTilde("~")));
  const fileName = path.basename(normalized).toLowerCase();

  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return true;
  }

  if (normalized === homeDir) {
    return true;
  }

  for (const dangerous of DANGEROUS_PATHS) {
    const normalizedDangerous = normalizeForComparison(dangerous);
    if (normalized === normalizedDangerous || normalized.startsWith(`${normalizedDangerous}/`)) {
      return true;
    }
  }

  return DANGEROUS_HOME_SEGMENTS.some((segment) => {
    const dangerousHomePath = `${homeDir}/${segment.toLowerCase()}`;
    return normalized === dangerousHomePath || normalized.startsWith(`${dangerousHomePath}/`);
  });
}

/**
 * 函数 `expandTilde` 的职责说明。
 * `expandTilde` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function expandTilde(inputPath: string): string {
  if (
    inputPath === "~" ||
    inputPath.startsWith(`~${path.sep}`) ||
    inputPath.startsWith("~/") ||
    inputPath.startsWith("~\\")
  ) {
    return path.join(homeDirectory(), inputPath.slice(1));
  }

  return inputPath;
}

/**
 * 函数 `homeDirectory` 的职责说明。
 * `homeDirectory` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function homeDirectory(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? path.resolve("/");
}

/**
 * 函数 `normalizeForComparison` 的职责说明。
 * `normalizeForComparison` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizeForComparison(inputPath: string): string {
  return inputPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() || "/";
}
