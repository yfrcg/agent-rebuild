import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface FileSummary {
  filePath: string;
  relativePath: string;
  summary: string;
  lines: number;
  sizeBytes: number;
  language: string;
  exports: string[];
  imports: string[];
  functions: string[];
  classes: string[];
}

const LANG_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript React",
  ".js": "JavaScript",
  ".jsx": "JavaScript React",
  ".mts": "TypeScript ESM",
  ".mjs": "JavaScript ESM",
  ".cjs": "CommonJS",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".c": "C",
  ".cpp": "C++",
  ".h": "C Header",
  ".hpp": "C++ Header",
  ".cs": "C#",
  ".rb": "Ruby",
  ".php": "PHP",
  ".swift": "Swift",
  ".kt": "Kotlin",
  ".md": "Markdown",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
  ".xml": "XML",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".sql": "SQL",
  ".sh": "Shell",
  ".bash": "Bash",
  ".ps1": "PowerShell",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

const IMPORT_PATTERNS = [
  /import\s+.*?from\s+['"]([^'"]+)['"]/g,
  /import\s+['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /from\s+(\S+)\s+import/g,
  /#include\s+[<"]([^>"]+)[>"]/g,
];

const EXPORT_PATTERNS = [
  /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g,
  /export\s+\{([^}]+)\}/g,
  /module\.exports\s*=/g,
];

const FUNCTION_PATTERNS = [
  /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
  /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/g,
  /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/g,
];

const CLASS_PATTERNS = [
  /(?:export\s+)?(?:(?:abstract|default)\s+)?class\s+(\w+)/g,
  /(?:export\s+)?interface\s+(\w+)/g,
];

export function hashContent(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

export function summarizeFile(filePath: string, root: string): FileSummary {
  const relativePath = path.relative(root, filePath);
  const ext = path.extname(filePath).toLowerCase();
  const language = LANG_MAP[ext] ?? ext.slice(1) ?? "unknown";

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return {
      filePath,
      relativePath,
      summary: "(unreadable)",
      lines: 0,
      sizeBytes: 0,
      language,
      exports: [],
      imports: [],
      functions: [],
      classes: [],
    };
  }

  const lines = content.split("\n");
  const sizeBytes = Buffer.byteLength(content, "utf8");

  const imports = extractMatches(content, IMPORT_PATTERNS);
  const exports = extractMatches(content, EXPORT_PATTERNS);
  const functions = extractMatches(content, FUNCTION_PATTERNS);
  const classes = extractMatches(content, CLASS_PATTERNS);

  const summary = buildSummary(relativePath, language, lines.length, functions, classes, exports, imports);

  return {
    filePath,
    relativePath,
    summary,
    lines: lines.length,
    sizeBytes,
    language,
    exports,
    imports,
    functions,
    classes,
  };
}

function extractMatches(content: string, patterns: RegExp[]): string[] {
  const matches = new Set<string>();
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) {
        for (const item of match[1].split(",")) {
          const trimmed = item.trim().replace(/['"]/g, "");
          if (trimmed && trimmed.length < 100) {
            matches.add(trimmed);
          }
        }
      }
    }
  }
  return [...matches].slice(0, 30);
}

function buildSummary(
  relativePath: string,
  language: string,
  lineCount: number,
  functions: string[],
  classes: string[],
  exports: string[],
  imports: string[]
): string {
  const parts: string[] = [];

  parts.push(`${relativePath} (${language}, ${lineCount} lines)`);

  if (classes.length > 0) {
    parts.push(`Defines: ${classes.slice(0, 10).join(", ")}`);
  }

  if (functions.length > 0) {
    parts.push(`Functions: ${functions.slice(0, 10).join(", ")}`);
  }

  if (exports.length > 0) {
    parts.push(`Exports: ${exports.slice(0, 10).join(", ")}`);
  }

  if (imports.length > 0) {
    const localImports = imports.filter((i) => i.startsWith(".") || i.startsWith("/"));
    if (localImports.length > 0) {
      parts.push(`Depends on: ${localImports.slice(0, 5).join(", ")}`);
    }
  }

  return parts.join(" | ");
}

export function hashFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("md5").update(content).digest("hex");
  } catch {
    return "";
  }
}
