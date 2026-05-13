/**
 * ?????CS336 ???
 * ???packages/core/src/config.ts
 * ??????????
 * ?????????????????? Skill ?????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "fs";
import * as path from "path";

export const DEFAULT_WINDOWS_PROJECT_ROOT = "D:\\WorkStation\\agent-rebuild";
export const DEFAULT_WINDOWS_WORKSPACE_ROOT = `${DEFAULT_WINDOWS_PROJECT_ROOT}\\workspace`;

/**
 * 函数 `resolveProjectRoot` 的职责说明。
 * `resolveProjectRoot` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function resolveProjectRoot(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env.WINDOWS_PROJECT_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  return path.resolve(DEFAULT_WINDOWS_PROJECT_ROOT);
}

/**
 * 函数 `resolveWorkspaceRoot` 的职责说明。
 * `resolveWorkspaceRoot` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function resolveWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env.WORKSPACE_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  return path.resolve(resolveProjectRoot(env), "workspace");
}

export const ROOT_DIR = resolveProjectRoot();
export const WORKSPACE_DIR = resolveWorkspaceRoot();

const TZ = process.env.TZ ?? "Asia/Shanghai";

/**
 * 函数 `ensureDir` 的职责说明。
 * `ensureDir` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 函数 `toLocalDateString` 的职责说明。
 * `toLocalDateString` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function toLocalDateString(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return fmt.format(date);
}

/**
 * 函数 `getDateString` 的职责说明。
 * `getDateString` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function getDateString(date = new Date()) {
  return toLocalDateString(date);
}

/**
 * 函数 `getTodayDateString` 的职责说明。
 * `getTodayDateString` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function getTodayDateString() {
  return toLocalDateString(new Date());
}

/**
 * 函数 `getYesterdayDateString` 的职责说明。
 * `getYesterdayDateString` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function getYesterdayDateString() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return toLocalDateString(date);
}

/**
 * 函数 `resolveWorkspacePath` 的职责说明。
 * `resolveWorkspacePath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function resolveWorkspacePath(...parts: string[]) {
  const workspaceRoot = resolveWorkspaceRoot();
  const fullPath = path.resolve(workspaceRoot, ...parts);
  const normalizedWorkspace = path.resolve(workspaceRoot);

  if (!fullPath.startsWith(normalizedWorkspace)) {
    throw new Error("Path escapes workspace");
  }

  return fullPath;
}
