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

export function normalizeSafePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    throw new Error("[guard] path is empty");
  }

  return path.normalize(expandTilde(trimmed));
}

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

function homeDirectory(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? path.resolve("/");
}

function normalizeForComparison(inputPath: string): string {
  return inputPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() || "/";
}
