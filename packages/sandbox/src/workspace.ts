import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type {
  SandboxArtifact,
  SandboxInputFile,
  SandboxWorkspaceAccess,
} from "./types";

const EXCLUDED_DIRECTORIES = new Set([
  ".agent-rebuild",
  ".aws",
  ".claude",
  ".config",
  ".docker",
  ".git",
  ".ssh",
  ".svn",
  ".hg",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "logs",
  "node_modules",
]);

const EXCLUDED_FILES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
]);

export interface PreparedWorkspace {
  workspaceDir: string;
  mountSource: string;
}

export async function prepareWorkspace(input: {
  rootDir: string;
  tempWorkspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
}): Promise<PreparedWorkspace> {
  const rootDir = path.resolve(input.rootDir);
  const tempWorkspaceDir = path.resolve(input.tempWorkspaceDir);

  switch (input.workspaceAccess) {
    case "none":
      await mkdir(tempWorkspaceDir, { recursive: true });
      return {
        workspaceDir: tempWorkspaceDir,
        mountSource: tempWorkspaceDir,
      };
    case "copy":
      await copyWorkspace(rootDir, tempWorkspaceDir);
      return {
        workspaceDir: tempWorkspaceDir,
        mountSource: tempWorkspaceDir,
      };
    case "ro":
    case "rw":
      return {
        workspaceDir: rootDir,
        mountSource: rootDir,
      };
  }
}

export async function putSandboxFiles(
  workspaceDir: string,
  files: SandboxInputFile[]
): Promise<void> {
  for (const file of files) {
    const target = path.resolve(workspaceDir, file.path);
    if (!target.startsWith(path.resolve(workspaceDir))) {
      throw new Error(`sandbox input file escapes workspace: ${file.path}`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      typeof file.content === "string" ? file.content : file.content,
      typeof file.content === "string" ? (file.encoding ?? "utf8") : undefined
    );
  }
}

export async function listArtifacts(artifactDir: string): Promise<SandboxArtifact[]> {
  const resolvedRoot = path.resolve(artifactDir);
  const output: SandboxArtifact[] = [];
  await collectArtifacts(resolvedRoot, resolvedRoot, output);
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

export async function removeWorkspace(dirPath: string): Promise<void> {
  await rm(dirPath, {
    recursive: true,
    force: true,
  });
}

async function copyWorkspace(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (!shouldCopyEntry(entry.name, entry.isDirectory())) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyWorkspace(sourcePath, targetPath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    const content = await readFile(sourcePath);
    await writeFile(targetPath, content);
  }
}

function shouldCopyEntry(name: string, isDirectory: boolean): boolean {
  if (EXCLUDED_FILES.has(name)) {
    return false;
  }

  if (isDirectory) {
    if (EXCLUDED_DIRECTORIES.has(name)) {
      return false;
    }
    if (name.startsWith(".") && name !== ".github") {
      return false;
    }
  }

  return true;
}

async function collectArtifacts(
  rootDir: string,
  currentDir: string,
  output: SandboxArtifact[]
): Promise<void> {
  await mkdir(currentDir, { recursive: true });
  const entries = await readdir(currentDir, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectArtifacts(rootDir, absolutePath, output);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const fileStat = await stat(absolutePath);
    output.push({
      path: path.relative(rootDir, absolutePath).replace(/\\/g, "/"),
      absolutePath,
      size: fileStat.size,
    });
  }
}

