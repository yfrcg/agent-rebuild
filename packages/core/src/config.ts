import * as fs from "fs";
import * as path from "path";

export const ROOT_DIR = process.cwd();
export const WORKSPACE_DIR = path.join(ROOT_DIR, "workspace");

export function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function getDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getTodayDateString() {
  return getDateString(new Date());
}

export function getYesterdayDateString() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return getDateString(date);
}

export function resolveWorkspacePath(...parts: string[]) {
  const fullPath = path.resolve(WORKSPACE_DIR, ...parts);
  const normalizedWorkspace = path.resolve(WORKSPACE_DIR);

  if (!fullPath.startsWith(normalizedWorkspace)) {
    throw new Error("Path escapes workspace");
  }

  return fullPath;
}