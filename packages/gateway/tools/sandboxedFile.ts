import * as fs from "node:fs";
import * as path from "node:path";
import { glob } from "glob";

import { resolveProjectRoot } from "../../core/src/config";
import { assertInsideWorkspace, isDangerousHostPath } from "../pathGuard";
import { createToolSecurityProfile } from "../toolSecurityProfile";
import type { GatewayTool, GatewayToolInput, GatewayToolOutput } from "../toolTypes";

export function createSandboxedFileTools(projectRoot = resolveProjectRoot()): GatewayTool[] {
  return [
    createFileReadTool(projectRoot),
    createFileWriteTool(projectRoot),
    createFileEditTool(projectRoot),
    createFileListTool(projectRoot),
    createFileGlobTool(projectRoot),
    createFileGrepTool(projectRoot),
    createFileMultiEditTool(projectRoot),
    createFilePatchTool(projectRoot),
  ];
}

function createFileReadTool(projectRoot: string): GatewayTool {
  const schema = filePathSchema();

  return {
    name: "file.read",
    description: "Read a UTF-8 text file inside the project workspace.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["file", "workspace", "read"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    sandboxSpec: {
      resolve(input) {
        const filePath = requirePath(input);
        const target = resolveWorkspaceTarget(projectRoot, filePath);
        const containerPath = toContainerPath(projectRoot, target);

        return {
          profileName: "safe-dev",
          projectRoot,
          command: buildNodeCommand([
            "const fs = require('node:fs');",
            `process.stdout.write(fs.readFileSync(${JSON.stringify(containerPath)}, 'utf8'));`,
          ]),
        };
      },
    },
    async invoke(input) {
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(projectRoot, filePath);
      return {
        ok: false,
        error: "file.read must execute through ToolCallExecutor",
        metadata: {
          path: relativeWorkspacePath(projectRoot, target),
        },
      };
    },
  };
}

function createFileWriteTool(projectRoot: string): GatewayTool {
  const schema = {
    ...filePathSchema(),
    properties: {
      path: {
        type: "string",
      },
      content: {
        type: "string",
      },
    },
    required: ["path", "content"],
  } satisfies Record<string, unknown>;

  return {
    name: "file.write",
    description: "Write a UTF-8 text file inside the project workspace.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: ["file", "workspace", "write"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: true,
      allowHostExecution: true,
      requireApproval: false,
    }),
    sandboxSpec: {
      resolve(input) {
        const filePath = requirePath(input);
        const content = requireString(input.content, "input.content required");
        const target = resolveWorkspaceTarget(projectRoot, filePath);
        const containerPath = toContainerPath(projectRoot, target);
        const encoded = Buffer.from(content, "utf8").toString("base64");

        return {
          profileName: "safe-dev",
          projectRoot,
          command: buildNodeCommand([
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            `const target = ${JSON.stringify(containerPath)};`,
            `const content = Buffer.from(${JSON.stringify(encoded)}, 'base64');`,
            "fs.mkdirSync(path.dirname(target), { recursive: true });",
            "fs.writeFileSync(target, content);",
          ]),
        };
      },
    },
    async invoke(input) {
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(projectRoot, filePath);
      return successPathOutput(projectRoot, target);
    },
  };
}

function createFileEditTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      path: {
        type: "string",
      },
      oldText: {
        type: "string",
      },
      newText: {
        type: "string",
      },
      find: {
        type: "string",
      },
      replace: {
        type: "string",
      },
    },
    required: ["path"],
  } satisfies Record<string, unknown>;

  return {
    name: "file.edit",
    description: "Replace one string occurrence in a UTF-8 text file inside the project workspace.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: ["file", "workspace", "edit"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: true,
      allowHostExecution: true,
      requireApproval: false,
    }),
    sandboxSpec: {
      resolve(input) {
        const filePath = requirePath(input);
        const oldText = requireString(
          input.oldText ?? input.find,
          "input.oldText required"
        );
        const newText = requireString(
          input.newText ?? input.replace,
          "input.newText required"
        );
        const target = resolveWorkspaceTarget(projectRoot, filePath);
        const containerPath = toContainerPath(projectRoot, target);
        const encodedOld = Buffer.from(oldText, "utf8").toString("base64");
        const encodedNew = Buffer.from(newText, "utf8").toString("base64");

        return {
          profileName: "safe-dev",
          projectRoot,
          command: buildNodeCommand([
            "const fs = require('node:fs');",
            `const target = ${JSON.stringify(containerPath)};`,
            "const source = fs.readFileSync(target, 'utf8');",
            `const oldText = Buffer.from(${JSON.stringify(encodedOld)}, 'base64').toString('utf8');`,
            `const newText = Buffer.from(${JSON.stringify(encodedNew)}, 'base64').toString('utf8');`,
            "if (!source.includes(oldText)) {",
            "  console.error('input.oldText not found');",
            "  process.exit(1);",
            "}",
            "fs.writeFileSync(target, source.replace(oldText, newText));",
          ]),
        };
      },
    },
    async invoke(input) {
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(projectRoot, filePath);
      return successPathOutput(projectRoot, target);
    },
  };
}

function createFileListTool(projectRoot: string): GatewayTool {
  const schema = filePathSchema();

  return {
    name: "file.list",
    description: "List files and directories inside the project workspace.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["file", "workspace", "list"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    sandboxSpec: {
      resolve(input) {
        const filePath = requirePath(input);
        const target = resolveWorkspaceTarget(projectRoot, filePath);
        const containerPath = toContainerPath(projectRoot, target);

        return {
          profileName: "safe-dev",
          projectRoot,
          command: buildNodeCommand([
            "const fs = require('node:fs');",
            `const target = ${JSON.stringify(containerPath)};`,
            "const entries = fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({",
            "  name: entry.name,",
            "  type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other'",
            "}));",
            "process.stdout.write(JSON.stringify(entries, null, 2));",
          ]),
        };
      },
    },
    async invoke(input) {
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(projectRoot, filePath);
      return {
        ok: false,
        error: "file.list must execute through ToolCallExecutor",
        metadata: {
          path: relativeWorkspacePath(projectRoot, target),
        },
      };
    },
  };
}

function resolveWorkspaceTarget(projectRoot: string, inputPath: string): string {
  const target = path.resolve(projectRoot, inputPath);
  assertInsideWorkspace(target, projectRoot);
  if (isDangerousHostPath(target)) {
    throw new Error(`[tool] blocked dangerous path: ${inputPath}`);
  }

  return target;
}

function filePathSchema() {
  return {
    type: "object",
    properties: {
      path: {
        type: "string",
      },
    },
    required: ["path"],
  } satisfies Record<string, unknown>;
}

function requirePath(input: GatewayToolInput): string {
  return requireString(input.path, "input.path required");
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }

  return value;
}

function successPathOutput(projectRoot: string, target: string): GatewayToolOutput {
  return {
    ok: true,
    content: {
      path: relativeWorkspacePath(projectRoot, target),
    },
    metadata: {
      path: relativeWorkspacePath(projectRoot, target),
    },
  };
}

function buildNodeCommand(lines: string[]): string {
  return `node - <<'NODE'\n${lines.join("\n")}\nNODE`;
}

function toContainerPath(projectRoot: string, target: string): string {
  const relativePath = relativeWorkspacePath(projectRoot, target);
  return relativePath ? path.posix.join("/workspace", relativePath) : "/workspace";
}

function relativeWorkspacePath(projectRoot: string, target: string): string {
  return path.relative(projectRoot, target).replace(/\\/g, "/");
}

function createFileGlobTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match files (e.g. '**/*.ts', 'src/**/*.test.*').",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return (default 100, max 500).",
      },
    },
    required: ["pattern"],
  } satisfies Record<string, unknown>;

  return {
    name: "file.glob",
    description: "Search workspace files by glob pattern. Returns relative paths. Ignores node_modules, .git, dist, build, coverage.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["file", "workspace", "search", "glob"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    async invoke(input) {
      const pattern = requireString(input.pattern, "input.pattern required");
      const maxResults = clampNumber(input.maxResults, 100, 1, 500);

      const matches = await glob(pattern, {
        cwd: projectRoot,
        nodir: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/coverage/**"],
        maxDepth: 20,
      });

      const limited = matches.slice(0, maxResults);
      return {
        ok: true,
        content: {
          pattern,
          matches: limited.map((m) => m.replace(/\\/g, "/")),
          totalMatches: matches.length,
          truncated: matches.length > maxResults,
        },
        metadata: { totalMatches: matches.length },
      };
    },
  };
}

function createFileGrepTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search string or regex pattern.",
      },
      path: {
        type: "string",
        description: "Directory or file to search in (default: workspace root).",
      },
      regex: {
        type: "boolean",
        description: "Treat query as regex (default: false).",
      },
      caseInsensitive: {
        type: "boolean",
        description: "Case-insensitive search (default: false).",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of match results (default 50, max 200).",
      },
      contextLines: {
        type: "number",
        description: "Number of context lines before/after match (default 1, max 5).",
      },
    },
    required: ["query"],
  } satisfies Record<string, unknown>;

  const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
  const MAX_FILE_SIZE = 512 * 1024;

  return {
    name: "file.grep",
    description: "Search for strings or regex patterns in workspace files. Returns file, line, preview, and context.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["file", "workspace", "search", "grep"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    async invoke(input) {
      const query = requireString(input.query, "input.query required");
      const searchPath = typeof input.path === "string" && input.path.trim()
        ? resolveWorkspaceTarget(projectRoot, input.path)
        : projectRoot;
      const isRegex = input.regex === true;
      const caseInsensitive = input.caseInsensitive === true;
      const maxResults = clampNumber(input.maxResults, 50, 1, 200);
      const contextLines = clampNumber(input.contextLines, 1, 0, 5);

      let matcher: (line: string) => boolean;
      if (isRegex) {
        try {
          const flags = caseInsensitive ? "i" : "";
          const re = new RegExp(query, flags);
          matcher = (line) => re.test(line);
        } catch {
          return { ok: false, error: `Invalid regex: ${query}` };
        }
      } else {
        const needle = caseInsensitive ? query.toLowerCase() : query;
        matcher = (line) => {
          const haystack = caseInsensitive ? line.toLowerCase() : line;
          return haystack.includes(needle);
        };
      }

      const results: Array<{ file: string; line: number; preview: string; context: string[] }> = [];
      let filesSearched = 0;

      function searchDir(dir: string) {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (results.length >= maxResults) return;
          if (IGNORE_DIRS.has(entry.name)) continue;

          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            searchDir(fullPath);
          } else if (entry.isFile()) {
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size > MAX_FILE_SIZE) continue;
              if (stat.size === 0) continue;
            } catch {
              continue;
            }

            filesSearched++;
            let lines: string[];
            try {
              const content = fs.readFileSync(fullPath, "utf8");
              lines = content.split("\n");
            } catch {
              continue;
            }

            for (let i = 0; i < lines.length; i++) {
              if (results.length >= maxResults) break;
              if (matcher(lines[i])) {
                const ctxStart = Math.max(0, i - contextLines);
                const ctxEnd = Math.min(lines.length - 1, i + contextLines);
                const context = lines.slice(ctxStart, ctxEnd + 1);
                results.push({
                  file: relativeWorkspacePath(projectRoot, fullPath),
                  line: i + 1,
                  preview: lines[i].slice(0, 300),
                  context,
                });
              }
            }
          }
        }
      }

      searchDir(searchPath);

      return {
        ok: true,
        content: {
          query,
          results,
          totalMatches: results.length,
          filesSearched,
          truncated: results.length >= maxResults,
        },
        metadata: { totalMatches: results.length, filesSearched },
      };
    },
  };
}

function createFileMultiEditTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to workspace root.",
      },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" },
          },
          required: ["oldText", "newText"],
        },
        description: "Array of {oldText, newText} replacements. Applied atomically.",
      },
    },
    required: ["path", "edits"],
  } satisfies Record<string, unknown>;

  return {
    name: "file.multi_edit",
    description: "Apply multiple string replacements to a single file atomically. If any edit fails, no changes are written.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: ["file", "workspace", "edit", "atomic"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: true,
      allowHostExecution: true,
      requireApproval: false,
    }),
    async invoke(input) {
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(projectRoot, filePath);

      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        return { ok: false, error: "input.edits must be a non-empty array" };
      }

      const edits = input.edits.map((e: unknown, i: number) => {
        if (!e || typeof e !== "object") throw new Error(`edit[${i}] must be an object`);
        const edit = e as Record<string, unknown>;
        if (typeof edit.oldText !== "string") throw new Error(`edit[${i}].oldText must be string`);
        if (typeof edit.newText !== "string") throw new Error(`edit[${i}].newText must be string`);
        return { oldText: edit.oldText, newText: edit.newText };
      });

      let content: string;
      try {
        content = fs.readFileSync(target, "utf8");
      } catch (err) {
        return { ok: false, error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}` };
      }

      const original = content;
      const applied: string[] = [];

      for (let i = 0; i < edits.length; i++) {
        const { oldText, newText } = edits[i];
        if (!content.includes(oldText)) {
          return {
            ok: false,
            error: `edit[${i}]: oldText not found in file. Applied ${applied.length}/${edits.length} edits so far (none written).`,
            content: { appliedEdits: applied, totalEdits: edits.length },
          };
        }
        content = content.replace(oldText, newText);
        applied.push(`edit[${i}]`);
      }

      try {
        fs.writeFileSync(target, content, "utf8");
      } catch (err) {
        return { ok: false, error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      return {
        ok: true,
        content: {
          path: relativeWorkspacePath(projectRoot, target),
          editsApplied: applied.length,
          totalEdits: edits.length,
          bytesChanged: Math.abs(Buffer.byteLength(content) - Buffer.byteLength(original)),
        },
        metadata: { path: relativeWorkspacePath(projectRoot, target) },
      };
    },
  };
}

function createFilePatchTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Target file path relative to workspace root.",
      },
      patch: {
        type: "string",
        description: "Unified diff patch content to apply.",
      },
      dryRun: {
        type: "boolean",
        description: "If true, only validate the patch without applying (default: false).",
      },
    },
    required: ["path", "patch"],
  } satisfies Record<string, unknown>;

  return {
    name: "file.patch",
    description: "Apply a unified diff patch to a file. Supports dryRun mode to preview without writing.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: ["file", "workspace", "patch"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: true,
      allowHostExecution: true,
      requireApproval: false,
    }),
    async invoke(input) {
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(projectRoot, filePath);
      const patchContent = requireString(input.patch, "input.patch required");
      const dryRun = input.dryRun === true;

      let content: string;
      try {
        content = fs.readFileSync(target, "utf8");
      } catch (err) {
        return { ok: false, error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}` };
      }

      const lines = content.split("\n");
      const patchLines = patchContent.split("\n");

      interface HunkEntry { type: "ctx" | "del" | "add"; text: string }
      interface Hunk { start: number; entries: HunkEntry[] }
      const hunks: Hunk[] = [];
      let currentHunk: Hunk | null = null;

      for (const line of patchLines) {
        if (line.startsWith("@@")) {
          const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (match) {
            if (currentHunk) hunks.push(currentHunk);
            currentHunk = { start: parseInt(match[1], 10) - 1, entries: [] };
          }
        } else if (currentHunk) {
          if (line.startsWith("-")) {
            currentHunk.entries.push({ type: "del", text: line.slice(1) });
          } else if (line.startsWith("+")) {
            currentHunk.entries.push({ type: "add", text: line.slice(1) });
          } else if (line.startsWith(" ")) {
            currentHunk.entries.push({ type: "ctx", text: line.slice(1) });
          } else if (line === "") {
            currentHunk.entries.push({ type: "ctx", text: "" });
          }
        }
      }
      if (currentHunk) hunks.push(currentHunk);

      if (hunks.length === 0) {
        return { ok: false, error: "No valid hunks found in patch" };
      }

      let result = lines;
      let offset = 0;

      for (const hunk of hunks) {
        let pos = hunk.start + offset;
        const newLines: string[] = [];

        for (const entry of hunk.entries) {
          if (entry.type === "ctx") {
            if (pos >= result.length || result[pos] !== entry.text) {
              return {
                ok: false,
                error: `Patch hunk context mismatch at line ${pos + 1}: expected "${entry.text}", found "${pos < result.length ? result[pos] : "<EOF>"}"`,
              };
            }
            newLines.push(entry.text);
            pos++;
          } else if (entry.type === "del") {
            if (pos >= result.length || result[pos] !== entry.text) {
              return {
                ok: false,
                error: `Patch hunk at line ${pos + 1}: expected "${entry.text}", found "${pos < result.length ? result[pos] : "<EOF>"}"`,
              };
            }
            pos++;
          } else if (entry.type === "add") {
            newLines.push(entry.text);
          }
        }

        const consumed = pos - (hunk.start + offset);
        result = [...result.slice(0, hunk.start + offset), ...newLines, ...result.slice(hunk.start + offset + consumed)];
        offset += newLines.length - consumed;
      }

      if (dryRun) {
        return {
          ok: true,
          content: {
            path: relativeWorkspacePath(projectRoot, target),
            dryRun: true,
            hunksApplied: hunks.length,
            newLineCount: result.length,
            originalLineCount: lines.length,
            preview: result.join("\n").slice(0, 2000),
          },
        };
      }

      try {
        fs.writeFileSync(target, result.join("\n"), "utf8");
      } catch (err) {
        return { ok: false, error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      return {
        ok: true,
        content: {
          path: relativeWorkspacePath(projectRoot, target),
          hunksApplied: hunks.length,
          newLineCount: result.length,
          originalLineCount: lines.length,
        },
        metadata: { path: relativeWorkspacePath(projectRoot, target) },
      };
    },
  };
}

function clampNumber(value: unknown, defaultVal: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultVal;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
