/**
 * ?????CS336 ???
 * ???packages/gateway/tools/sandboxedFile.ts
 * ??????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { glob } from "glob";

import { resolveProjectRoot } from "../../core/src/config";
import { assertInsideWorkspace, isDangerousHostPath } from "../pathGuard";
import { createToolSecurityProfile } from "../toolSecurityProfile";
import type {
  GatewayTool,
  GatewayToolContext,
  GatewayToolInput,
  GatewayToolOutput,
} from "../toolTypes";

/**
 * 函数 `createSandboxedFileTools` 的职责说明。
 * `createSandboxedFileTools` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

/**
 * 函数 `createFileReadTool` 的职责说明。
 * `createFileReadTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
      /** 方法 `resolve`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
      resolve(input, context) {
        const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
        const filePath = requirePath(input);
        const target = resolveWorkspaceTarget(workspaceRoot, filePath);
        const containerPath = toContainerPath(workspaceRoot, target);

        return {
          profileName: "safe-dev",
          projectRoot: workspaceRoot,
          command: buildNodeCommand([
            "const fs = require('node:fs');",
            `process.stdout.write(fs.readFileSync(${JSON.stringify(containerPath)}, 'utf8'));`,
          ]),
        };
      },
    },
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input, context) {
      const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(workspaceRoot, filePath);
      const MAX_READ_CHARS = 65536;
      const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB hard limit
      const offset = typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 0;
      const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 0;
      const stat = await fsp.stat(target);
      if (stat.size > MAX_FILE_BYTES) {
        return {
          ok: false,
          error: `File too large: ${stat.size} bytes exceeds the ${MAX_FILE_BYTES} byte limit. Use offset/limit parameters or shell.run (Get-Content) to read specific ranges.`,
          metadata: {
            path: relativeWorkspacePath(workspaceRoot, target),
            sizeBytes: stat.size,
            maxBytes: MAX_FILE_BYTES,
          },
        };
      }
      if (stat.size > MAX_READ_CHARS * 2) {
        const handle = await fsp.open(target, "r");
        const buf = Buffer.alloc(MAX_READ_CHARS);
        const { bytesRead } = await handle.read(buf, 0, MAX_READ_CHARS, 0);
        await handle.close();
        const content = buf.toString("utf8", 0, bytesRead);
        return {
          ok: true,
          content,
          metadata: {
            path: relativeWorkspacePath(workspaceRoot, target),
            truncated: true,
            originalSizeBytes: stat.size,
            warning: `File truncated: showing first ${MAX_READ_CHARS} chars of ${stat.size} byte file. Use offset/limit parameters or shell.run (Get-Content) for specific ranges.`,
          },
        };
      }
      const fullContent = await fsp.readFile(target, "utf8");

      // If offset/limit specified, extract the requested line range
      if (offset > 0 || limit > 0) {
        const allLines = fullContent.split("\n");
        const startLine = offset;
        const endLine = limit > 0 ? startLine + limit : allLines.length;
        const selectedLines = allLines.slice(startLine, endLine);
        const content = selectedLines.join("\n");
        const totalLines = allLines.length;
        return {
          ok: true,
          content: content.length > MAX_READ_CHARS ? content.slice(0, MAX_READ_CHARS) : content,
          metadata: {
            path: relativeWorkspacePath(workspaceRoot, target),
            lineRange: `${startLine}-${Math.min(endLine, totalLines)} of ${totalLines}`,
            truncated: content.length > MAX_READ_CHARS,
          },
        };
      }

      if (fullContent.length > MAX_READ_CHARS) {
        return {
          ok: true,
          content: fullContent.slice(0, MAX_READ_CHARS),
          metadata: {
            path: relativeWorkspacePath(workspaceRoot, target),
            truncated: true,
            originalLength: fullContent.length,
            warning: `File truncated: showing first ${MAX_READ_CHARS} chars of ${fullContent.length} char file.`,
          },
        };
      }
      return {
        ok: true,
        content: fullContent,
        metadata: {
          path: relativeWorkspacePath(workspaceRoot, target),
        },
      };
    },
  };
}

/**
 * 函数 `createFileWriteTool` 的职责说明。
 * `createFileWriteTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
      /** 方法 `resolve`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
      resolve(input, context) {
        const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
        const filePath = requirePath(input);
        const content = requireText(input.content, "input.content required");
        const target = resolveWorkspaceTarget(workspaceRoot, filePath);
        const containerPath = toContainerPath(workspaceRoot, target);
        const encoded = Buffer.from(content, "utf8").toString("base64");

        return {
          profileName: "safe-dev",
          projectRoot: workspaceRoot,
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
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input, context) {
      const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
      const filePath = requirePath(input);
      const content = requireText(input.content, "input.content required");
      const target = resolveWorkspaceTarget(workspaceRoot, filePath);
      const dir = path.dirname(target);
      try {
        await fsp.access(dir);
      } catch {
        await fsp.mkdir(dir, { recursive: true });
      }
      await writeTextFileRobustly(target, content);
      return successPathOutput(workspaceRoot, target);
    },
  };
}

/**
 * 函数 `createFileEditTool` 的职责说明。
 * `createFileEditTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
      /** 方法 `resolve`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
      resolve(input, context) {
        const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
        const filePath = requirePath(input);
        const oldText = requireString(
          input.oldText ?? input.find,
          "input.oldText required"
        );
        const newText = requireString(
          input.newText ?? input.replace,
          "input.newText required"
        );
        const target = resolveWorkspaceTarget(workspaceRoot, filePath);
        const containerPath = toContainerPath(workspaceRoot, target);
        const encodedOld = Buffer.from(oldText, "utf8").toString("base64");
        const encodedNew = Buffer.from(newText, "utf8").toString("base64");

        return {
          profileName: "safe-dev",
          projectRoot: workspaceRoot,
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
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input, context) {
      const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
      const filePath = requirePath(input);
      const oldText = requireString(
        input.oldText ?? input.find,
        "input.oldText required"
      );
      const newText = requireString(
        input.newText ?? input.replace,
        "input.newText required"
      );
      const target = resolveWorkspaceTarget(workspaceRoot, filePath);
      const source = await fsp.readFile(target, "utf8");
      if (!source.includes(oldText)) {
        return {
          ok: false,
          error: "input.oldText not found",
          metadata: { path: relativeWorkspacePath(workspaceRoot, target) },
        };
      }
      await writeTextFileRobustly(target, source.replace(oldText, newText));
      return successPathOutput(workspaceRoot, target);
    },
  };
}

/**
 * 函数 `createFileListTool` 的职责说明。
 * `createFileListTool` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
      /** 方法 `resolve`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
      resolve(input, context) {
        const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
        const filePath = requirePath(input);
        const target = resolveWorkspaceTarget(workspaceRoot, filePath);
        const containerPath = toContainerPath(workspaceRoot, target);

        return {
          profileName: "safe-dev",
          projectRoot: workspaceRoot,
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
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input, context) {
      const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(workspaceRoot, filePath);
      const entries = (await fsp.readdir(target, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
      }));
      return {
        ok: true,
        content: entries,
        metadata: {
          path: relativeWorkspacePath(workspaceRoot, target),
        },
      };
    },
  };
}

/**
 * 函数 `resolveWorkspaceTarget` 的职责说明。
 * `resolveWorkspaceTarget` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function resolveWorkspaceTarget(projectRoot: string, inputPath: string): string {
  const target = path.resolve(projectRoot, inputPath);
  assertInsideWorkspace(target, projectRoot);
  if (isDangerousHostPath(target)) {
    throw new Error(`[tool] blocked dangerous path: ${inputPath}`);
  }

  return target;
}

function resolveContextProjectRoot(
  fallbackRoot: string,
  context: GatewayToolContext | undefined
): string {
  return context?.projectBoundary?.projectDir
    ? path.resolve(context.projectBoundary.projectDir)
    : fallbackRoot;
}

/**
 * 函数 `filePathSchema` 的职责说明。
 * `filePathSchema` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
const WRITE_RETRY_DELAYS_MS = [40, 120, 300];

async function writeTextFileRobustly(target: string, content: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= WRITE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await fsp.writeFile(target, content, "utf8");
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientWriteError(error) || attempt === WRITE_RETRY_DELAYS_MS.length) {
        break;
      }
      await delay(WRITE_RETRY_DELAYS_MS[attempt]);
    }
  }

  try {
    execSync(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "New-Item -ItemType Directory -Force -Path '${path.dirname(target).replace(/'/g, "''")}'; Set-Content -Path '${target.replace(/'/g, "''")}' -Value ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(content).toString("base64")}'))) -Encoding UTF8"`,
      { stdio: "pipe", timeout: 10000 }
    );
    return;
  } catch (fallbackError) {
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw fallbackError;
  }
}

function isTransientWriteError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return code === "EPERM" || code === "EBUSY" || code === "EMFILE" || code === "ENFILE" || code === "UNKNOWN";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function filePathSchema() {
  return {
    type: "object",
    properties: {
      path: {
        type: "string",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (0-based). Omit to start from beginning.",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read. Omit to read the entire file (up to 64KB limit).",
      },
    },
    required: ["path"],
  } satisfies Record<string, unknown>;
}

/**
 * 函数 `requirePath` 的职责说明。
 * `requirePath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function requirePath(input: GatewayToolInput): string {
  return requireString(input.path, "input.path required");
}

/**
 * 函数 `requireString` 的职责说明。
 * `requireString` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }

  return value;
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  return value;
}

/**
 * 函数 `successPathOutput` 的职责说明。
 * `successPathOutput` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

/**
 * 函数 `buildNodeCommand` 的职责说明。
 * `buildNodeCommand` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function buildNodeCommand(lines: string[]): string {
  return `node - <<'NODE'\n${lines.join("\n")}\nNODE`;
}

/**
 * 函数 `toContainerPath` 的职责说明。
 * `toContainerPath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function toContainerPath(projectRoot: string, target: string): string {
  const relativePath = relativeWorkspacePath(projectRoot, target);
  return relativePath ? path.posix.join("/workspace", relativePath) : "/workspace";
}

/**
 * 函数 `relativeWorkspacePath` 的职责说明。
 * `relativeWorkspacePath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function relativeWorkspacePath(projectRoot: string, target: string): string {
  return path.relative(projectRoot, target).replace(/\\/g, "/");
}

/**
 * 函数 `createFileGlobTool` 的职责说明。
 * `createFileGlobTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input, context) {
      const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
      const pattern = requireString(input.pattern, "input.pattern required");
      const maxResults = clampNumber(input.maxResults, 100, 1, 500);

      const matches = await glob(pattern, {
        cwd: workspaceRoot,
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

/**
 * 函数 `createFileGrepTool` 的职责说明。
 * `createFileGrepTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input, context) {
      const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
      const query = requireString(input.query, "input.query required");
      const searchPath = typeof input.path === "string" && input.path.trim()
        ? resolveWorkspaceTarget(workspaceRoot, input.path)
        : workspaceRoot;
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

      async function searchDir(dir: string) {
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (results.length >= maxResults) return;
          if (IGNORE_DIRS.has(entry.name)) continue;

          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await searchDir(fullPath);
          } else if (entry.isFile()) {
            try {
              const stat = await fsp.stat(fullPath);
              if (stat.size > MAX_FILE_SIZE) continue;
              if (stat.size === 0) continue;
            } catch {
              continue;
            }

            filesSearched++;
            let lines: string[];
            try {
              const content = await fsp.readFile(fullPath, "utf8");
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
                  file: relativeWorkspacePath(workspaceRoot, fullPath),
                  line: i + 1,
                  preview: lines[i].slice(0, 300),
                  context,
                });
              }
            }
          }
        }
      }

      await searchDir(searchPath);

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

/**
 * 函数 `createFileMultiEditTool` 的职责说明。
 * `createFileMultiEditTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input, context) {
      const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(workspaceRoot, filePath);

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
        content = await fsp.readFile(target, "utf8");
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
        await writeTextFileRobustly(target, content);
      } catch (err) {
        return { ok: false, error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      return {
        ok: true,
        content: {
          path: relativeWorkspacePath(workspaceRoot, target),
          editsApplied: applied.length,
          totalEdits: edits.length,
          bytesChanged: Math.abs(Buffer.byteLength(content) - Buffer.byteLength(original)),
        },
        metadata: { path: relativeWorkspacePath(workspaceRoot, target) },
      };
    },
  };
}

/**
 * 函数 `createFilePatchTool` 的职责说明。
 * `createFilePatchTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input, context) {
      const workspaceRoot = resolveContextProjectRoot(projectRoot, context);
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(workspaceRoot, filePath);
      const patchContent = requireString(input.patch, "input.patch required");
      const dryRun = input.dryRun === true;

      let content: string;
      try {
        content = await fsp.readFile(target, "utf8");
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
            path: relativeWorkspacePath(workspaceRoot, target),
            dryRun: true,
            hunksApplied: hunks.length,
            newLineCount: result.length,
            originalLineCount: lines.length,
            preview: result.join("\n").slice(0, 2000),
          },
        };
      }

      try {
        await writeTextFileRobustly(target, result.join("\n"));
      } catch (err) {
        return { ok: false, error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      return {
        ok: true,
        content: {
          path: relativeWorkspacePath(workspaceRoot, target),
          hunksApplied: hunks.length,
          newLineCount: result.length,
          originalLineCount: lines.length,
        },
        metadata: { path: relativeWorkspacePath(workspaceRoot, target) },
      };
    },
  };
}

/**
 * 函数 `clampNumber` 的职责说明。
 * `clampNumber` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function clampNumber(value: unknown, defaultVal: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultVal;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
