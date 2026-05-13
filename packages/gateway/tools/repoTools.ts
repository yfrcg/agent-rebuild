/**
 * ?????CS336 ???
 * ???packages/gateway/tools/repoTools.ts
 * ??????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import * as path from "node:path";
import { resolveProjectRoot } from "../../core/src/config";
import { createToolSecurityProfile } from "../toolSecurityProfile";
import type { GatewayTool, GatewayToolInput, GatewayToolOutput } from "../toolTypes";
import { buildRepoIndex, formatTree, hashFile, isBinaryFile } from "../repoIndexer";
import { extractSymbols, formatSymbols } from "../symbolIndex";
import { summarizeFile } from "../fileSummarizer";
import { extractImports, resolveImportPath } from "../dependencyGraph";

export function createRepoTools(projectRoot = resolveProjectRoot()): GatewayTool[] {
  return [
    createRepoMapTool(projectRoot),
    createRepoSymbolsTool(projectRoot),
    createRepoDepsTool(projectRoot),
  ];
}

function createRepoMapTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Subdirectory to map (relative to project root). Default: entire project.",
      },
      maxDepth: {
        type: "number",
        description: "Maximum directory depth to show (default 3, max 6).",
      },
      includeHidden: {
        type: "boolean",
        description: "Include hidden files/dirs (default false).",
      },
    },
  } satisfies Record<string, unknown>;

  return {
    name: "repo.map",
    description: "Get the project file tree structure. Returns a formatted tree view with file sizes. Use this first to understand project layout before reading specific files.",
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
      tags: ["repo", "map", "tree", "structure"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    async invoke(input) {
      const subPath = typeof input.path === "string" ? input.path.trim() : "";
      const maxDepth = clampNumber(input.maxDepth, 3, 1, 6);
      const targetDir = subPath ? path.resolve(projectRoot, subPath) : projectRoot;

      if (!targetDir.startsWith(projectRoot)) {
        return { ok: false, error: "Path must be within project root." };
      }

      const index = buildRepoIndex(targetDir);
      const treeStr = formatTree(index.tree, maxDepth);

      return {
        ok: true,
        content: {
          tree: treeStr,
          fileCount: index.fileCount,
          dirCount: index.dirCount,
          totalSizeKB: Math.round(index.totalSize / 1024),
          gitBranch: index.gitBranch,
          gitCommit: index.gitCommit,
          indexedAt: index.indexedAt,
        },
        metadata: {
          fileCount: index.fileCount,
          dirCount: index.dirCount,
        },
      };
    },
  };
}

function createRepoSymbolsTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "File path relative to project root. If omitted, returns symbols for all tracked files.",
      },
      pattern: {
        type: "string",
        description: "Glob pattern to filter files (e.g. '**/*.ts'). Only used when file is omitted.",
      },
      kinds: {
        type: "array",
        items: { type: "string" },
        description: "Filter by symbol kinds: function, class, interface, type, const, enum, export, import.",
      },
      maxFiles: {
        type: "number",
        description: "Max files to scan when using pattern (default 20, max 100).",
      },
    },
  } satisfies Record<string, unknown>;

  return {
    name: "repo.symbols",
    description: "Extract symbols (functions, classes, interfaces, types, exports) from source files. Use to understand code structure before making changes.",
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
      tags: ["repo", "symbols", "code", "structure"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    async invoke(input) {
      const file = typeof input.file === "string" ? input.file.trim() : "";
      const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
      const maxFiles = clampNumber(input.maxFiles, 20, 1, 100);

      if (file) {
        const fullPath = path.resolve(projectRoot, file);
        if (!fullPath.startsWith(projectRoot)) {
          return { ok: false, error: "File must be within project root." };
        }

        const symbols = extractSymbols(fullPath);
        const summary = summarizeFile(fullPath, projectRoot);

        let kindFilter: string[] = [];
        if (Array.isArray(input.kinds)) {
          kindFilter = input.kinds.filter((k: unknown) => typeof k === "string");
        }

        const filtered = kindFilter.length > 0
          ? symbols.filter((s) => kindFilter.includes(s.kind))
          : symbols;

        return {
          ok: true,
          content: {
            file: path.relative(projectRoot, fullPath),
            summary: summary.summary,
            language: summary.language,
            lines: summary.lines,
            symbols: filtered.map((s) => ({
              name: s.name,
              kind: s.kind,
              line: s.line,
              signature: s.signature,
              modifiers: s.modifiers,
            })),
            totalSymbols: filtered.length,
            formatted: formatSymbols(filtered),
          },
          metadata: { totalSymbols: filtered.length },
        };
      }

      return {
        ok: true,
        content: {
          note: "Please specify a 'file' path. Use repo.map first to see available files.",
          example: { file: "packages/gateway/gateway.ts" },
        },
        metadata: {},
      };
    },
  };
}

function createRepoDepsTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "File path relative to project root. Shows its imports and what imports it.",
      },
    },
    required: ["file"],
  } satisfies Record<string, unknown>;

  return {
    name: "repo.deps",
    description: "Show import/require dependencies for a file. Lists what it imports and what imports it. Use to understand code relationships before refactoring.",
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
      tags: ["repo", "deps", "imports", "dependencies"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowHostExecution: true,
      allowWrite: false,
    }),
    async invoke(input) {
      const file = typeof input.file === "string" ? input.file.trim() : "";
      if (!file) {
        return { ok: false, error: "file path is required." };
      }

      const fullPath = path.resolve(projectRoot, file);
      if (!fullPath.startsWith(projectRoot)) {
        return { ok: false, error: "File must be within project root." };
      }

      const imports = extractImports(fullPath);

      const resolvedImports = imports.map((imp) => {
        const resolved = resolveImportPath(fullPath, imp.specifier);
        return {
          specifier: imp.specifier,
          kind: imp.kind,
          resolved: resolved ? path.relative(projectRoot, resolved) : null,
        };
      });

      const externalImports = imports.filter((i) => !i.specifier.startsWith(".") && !i.specifier.startsWith("/"));
      const localImports = resolvedImports.filter((i) => i.resolved !== null);

      return {
        ok: true,
        content: {
          file: path.relative(projectRoot, fullPath),
          imports: {
            local: localImports,
            external: externalImports.map((i) => ({ specifier: i.specifier, kind: i.kind })),
            totalLocal: localImports.length,
            totalExternal: externalImports.length,
          },
        },
        metadata: {
          totalImports: imports.length,
          localCount: localImports.length,
          externalCount: externalImports.length,
        },
      };
    },
  };
}

function clampNumber(value: unknown, defaultVal: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultVal;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
