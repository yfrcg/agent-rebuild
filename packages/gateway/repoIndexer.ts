import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";

export interface FileNode {
  path: string;
  relativePath: string;
  isDir: boolean;
  size: number;
  hash?: string;
  ext?: string;
  children?: FileNode[];
}

export interface RepoIndex {
  root: string;
  tree: FileNode;
  fileCount: number;
  dirCount: number;
  totalSize: number;
  indexedAt: string;
  gitBranch?: string;
  gitCommit?: string;
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".tox", ".venv", "venv", "env", ".env",
  "dist", "build", "out", ".next", ".nuxt", ".output",
  ".turbo", ".cache", ".parcel-cache",
  "coverage", ".nyc_output",
  "target", "bin", "obj",
  ".idea", ".vscode",
  "logs", "tmp", "temp",
]);

const IGNORED_FILES = new Set([
  ".DS_Store", "Thumbs.db", "desktop.ini",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  ".gitignore", ".npmignore", ".eslintrc", ".prettierrc",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp",
  ".mp3", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".exe", ".dll", ".so", ".dylib",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".sqlite", ".db",
]);

const SCAN_LIMIT = 10000;

export function hashFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("md5").update(content).digest("hex");
  } catch {
    return "";
  }
}

export function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTS.has(ext);
}

export function shouldIgnoreDir(dirName: string): boolean {
  return IGNORED_DIRS.has(dirName) || dirName.startsWith(".");
}

export function shouldIgnoreFile(fileName: string): boolean {
  return IGNORED_FILES.has(fileName) || fileName.startsWith(".");
}

export function scanProjectTree(root: string, maxDepth = 6): FileNode {
  const rootNode: FileNode = {
    path: root,
    relativePath: ".",
    isDir: true,
    size: 0,
    children: [],
  };

  let fileCount = 0;
  let dirCount = 0;
  let totalSize = 0;

  function scanDir(dirNode: FileNode, depth: number): void {
    if (depth > maxDepth || fileCount >= SCAN_LIMIT) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirNode.path, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (fileCount >= SCAN_LIMIT) break;

      const fullPath = path.join(dirNode.path, entry.name);
      const relPath = path.relative(root, fullPath);

      if (entry.isDirectory()) {
        if (shouldIgnoreDir(entry.name)) continue;
        dirCount++;
        const childDir: FileNode = {
          path: fullPath,
          relativePath: relPath,
          isDir: true,
          size: 0,
          children: [],
        };
        dirNode.children!.push(childDir);
        scanDir(childDir, depth + 1);
      } else if (entry.isFile()) {
        if (shouldIgnoreFile(entry.name)) continue;
        if (isBinaryFile(entry.name)) continue;

        let size = 0;
        try {
          const stat = fs.statSync(fullPath);
          size = stat.size;
        } catch {
          continue;
        }

        if (size > 1024 * 1024) continue;

        fileCount++;
        totalSize += size;

        dirNode.children!.push({
          path: fullPath,
          relativePath: relPath,
          isDir: false,
          size,
          ext: path.extname(entry.name).toLowerCase(),
        });
      }
    }

    dirNode.size = (dirNode.children ?? []).reduce((sum, c) => sum + c.size, 0);
  }

  scanDir(rootNode, 0);
  rootNode.size = totalSize;

  return rootNode;
}

export function buildRepoIndex(root: string): RepoIndex {
  const tree = scanProjectTree(root);

  let fileCount = 0;
  let dirCount = 0;
  let totalSize = 0;

  function countNodes(node: FileNode): void {
    if (node.isDir) {
      dirCount++;
      for (const child of node.children ?? []) {
        countNodes(child);
      }
    } else {
      fileCount++;
      totalSize += node.size;
    }
  }
  countNodes(tree);

  let gitBranch: string | undefined;
  let gitCommit: string | undefined;
  try {
    gitBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
    gitCommit = execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    // not a git repo
  }

  return {
    root,
    tree,
    fileCount,
    dirCount,
    totalSize,
    indexedAt: new Date().toISOString(),
    gitBranch,
    gitCommit,
  };
}

export function getChangedFiles(root: string): string[] {
  try {
    const output = execSync("git diff --name-only HEAD", { cwd: root, encoding: "utf8", timeout: 10000 }).trim();
    const staged = execSync("git diff --cached --name-only", { cwd: root, encoding: "utf8", timeout: 10000 }).trim();
    const untracked = execSync("git ls-files --others --exclude-standard", { cwd: root, encoding: "utf8", timeout: 10000 }).trim();

    return [...output, ...staged, ...untracked]
      .flatMap((s: string) => s.split("\n"))
      .filter(Boolean)
      .map((f: string) => path.resolve(root, f));
  } catch {
    return [];
  }
}

export function formatTree(node: FileNode, maxDepth = 3, currentDepth = 0): string {
  const lines: string[] = [];
  const indent = "  ".repeat(currentDepth);

  if (currentDepth === 0) {
    lines.push(".");
  }

  const children = (node.children ?? []).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.relativePath.localeCompare(b.relativePath);
  });

  for (const child of children) {
    if (child.isDir) {
      if (currentDepth < maxDepth) {
        lines.push(`${indent}├── ${child.relativePath.split(path.sep).pop()}/`);
        if (currentDepth + 1 < maxDepth) {
          lines.push(...formatTree(child, maxDepth, currentDepth + 1).split("\n").filter(Boolean).map((l) => `${indent}  ${l}`));
        }
      } else {
        lines.push(`${indent}├── ${child.relativePath.split(path.sep).pop()}/ (${(child.children ?? []).length} items)`);
      }
    } else {
      const sizeStr = child.size > 1024 ? `${Math.round(child.size / 1024)}KB` : `${child.size}B`;
      lines.push(`${indent}├── ${child.relativePath.split(path.sep).pop()} [${sizeStr}]`);
    }
  }

  return lines.join("\n");
}
