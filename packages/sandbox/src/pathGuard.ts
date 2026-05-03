import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

const DANGEROUS_SEGMENTS = [
  "/",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/var/run",
  "/var/run/docker.sock",
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
    throw new Error("[sandbox] path is empty");
  }

  return path.normalize(expandTilde(trimmed));
}

export function assertInsideWorkspace(targetPath: string, workspaceRoot: string): void {
  const targetRealPath = resolvePathWithExistingParent(targetPath);
  const workspaceRealPath = resolvePathWithExistingParent(workspaceRoot);
  const relative = path.relative(workspaceRealPath, targetRealPath);

  if (relative === "" || relative === ".") {
    return;
  }

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`[sandbox] path escapes workspace: ${targetPath}`);
  }
}

export function isDangerousHostPath(candidatePath: string): boolean {
  const normalized = normalizeForComparison(resolvePathWithExistingParent(candidatePath));
  const homeDir = normalizeForComparison(resolvePathWithExistingParent(expandTilde("~")));
  const fileName = path.basename(normalized).toLowerCase();

  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return true;
  }

  if (normalized === homeDir) {
    return true;
  }

  if (DANGEROUS_SEGMENTS.some((segment) => normalized === segment || normalized.startsWith(`${segment}/`))) {
    return true;
  }

  return DANGEROUS_HOME_SEGMENTS.some((segment) => {
    const dangerousHomePath = `${homeDir}/${segment.toLowerCase()}`;
    return normalized === dangerousHomePath || normalized.startsWith(`${dangerousHomePath}/`);
  });
}

export function validateBindMountSource(candidatePath: string): void {
  const normalized = normalizeSafePath(candidatePath);
  if (normalized === path.parse(normalized).root || normalized === expandTilde("~")) {
    throw new Error(`[sandbox] refusing to mount dangerous path: ${candidatePath}`);
  }

  if (isDangerousHostPath(normalized)) {
    throw new Error(`[sandbox] refusing to mount sensitive path: ${candidatePath}`);
  }
}

function expandTilde(inputPath: string): string {
  if (inputPath === "~" || inputPath.startsWith(`~${path.sep}`) || inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(homeDirectory(), inputPath.slice(1));
  }

  return inputPath;
}

function homeDirectory(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? path.resolve("/");
}

function resolvePathWithExistingParent(candidatePath: string): string {
  const normalized = path.resolve(normalizeSafePath(candidatePath));
  if (existsSync(normalized)) {
    return realpathSync.native(normalized);
  }

  const parent = path.dirname(normalized);
  if (parent === normalized) {
    return normalized;
  }

  const resolvedParent = resolvePathWithExistingParent(parent);
  return path.join(resolvedParent, path.basename(normalized));
}

function normalizeForComparison(inputPath: string): string {
  return inputPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() || "/";
}
