import * as fs from "fs";
import * as path from "path";

export const DEFAULT_WINDOWS_PROJECT_ROOT = "D:\\WorkStation\\agent-rebuild";
export const DEFAULT_WINDOWS_WORKSPACE_ROOT = `${DEFAULT_WINDOWS_PROJECT_ROOT}\\workspace`;

export function resolveProjectRoot(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env.WINDOWS_PROJECT_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  return path.resolve(DEFAULT_WINDOWS_PROJECT_ROOT);
}

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

export function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function toLocalDateString(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return fmt.format(date);
}

export function getDateString(date = new Date()) {
  return toLocalDateString(date);
}

export function getTodayDateString() {
  return toLocalDateString(new Date());
}

export function getYesterdayDateString() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return toLocalDateString(date);
}

export function resolveWorkspacePath(...parts: string[]) {
  const fullPath = path.resolve(WORKSPACE_DIR, ...parts);
  const normalizedWorkspace = path.resolve(WORKSPACE_DIR);

  if (!fullPath.startsWith(normalizedWorkspace)) {
    throw new Error("Path escapes workspace");
  }

  return fullPath;
}
