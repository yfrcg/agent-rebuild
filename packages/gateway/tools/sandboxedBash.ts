
import * as fs from "node:fs";
import * as path from "node:path";

import { createToolSecurityProfile } from "../toolSecurityProfile";
import { resolveProjectRoot } from "../../core/src/config";
import type { GatewayTool, GatewayToolInput } from "../toolTypes";

const DEFAULT_PROFILE = "safe-dev";
const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000;

interface ExecutionCommandSpec {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  envAllowlist?: string[];
  workspaceMount?: string;
  networkPolicy?: string;
  resourceLimits?: Record<string, unknown>;
  profileName?: string;
}

interface SandboxedExecutionToolOptions {
  projectRoot?: string;
  toolName: string;
  description: string;
  schema: Record<string, unknown>;
  timeoutMs?: number;
  policyTags?: string[];
  resolveCommand: (
    input: GatewayToolInput,
    projectRoot: string
  ) => ExecutionCommandSpec;
}

/**
 * 函数 `createSandboxedBashTool` 的职责说明。
 * `createSandboxedBashTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createSandboxedBashTool(
  projectRoot = resolveProjectRoot(),
  toolName = "shell.run"
): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      command: {
        type: "string",
      },
      profileName: {
        type: "string",
        enum: ["plan", "safe-dev", "elevated"],
      },
      cwd: {
        type: "string",
        description:
          "Optional Windows project path. Use D:\\WorkStation\\agent-rebuild, not /workspace.",
      },
      timeoutMs: {
        type: "number",
      },
      env: {
        type: "object",
      },
      stdin: {
        type: "string",
      },
    },
    required: ["command"],
  } satisfies Record<string, unknown>;

  return createSandboxedExecutionTool({
    projectRoot,
    toolName,
    description: "Run a shell command locally in the project workspace.",
    schema,
    timeoutMs: DEFAULT_EXECUTION_TIMEOUT_MS,
    policyTags: ["execution", "shell"],
    /** 方法 `resolveCommand`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    resolveCommand(input, root) {
      const command = requireString(input.command, "input.command required");
      const env = normalizeEnv(input.env);
      return {
        command,
        cwd: normalizeShellCwd(input.cwd, root),
        timeoutMs: normalizeTimeout(input.timeoutMs, DEFAULT_EXECUTION_TIMEOUT_MS),
        env,
        envAllowlist: env ? Object.keys(env) : [],
        workspaceMount: root,
        networkPolicy:
          typeof input.profileName === "string" && input.profileName.trim() === "elevated"
            ? "restricted"
            : "none",
        profileName:
          typeof input.profileName === "string" && input.profileName.trim().length > 0
            ? input.profileName.trim()
            : DEFAULT_PROFILE,
      };
    },
  });
}

/**
 * 函数 `createSandboxedRunTestTool` 的职责说明。
 * `createSandboxedRunTestTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createSandboxedRunTestTool(
  projectRoot = resolveProjectRoot()
): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      command: {
        type: "string",
      },
      cwd: {
        type: "string",
      },
      timeoutMs: {
        type: "number",
      },
    },
  } satisfies Record<string, unknown>;

  return createSandboxedExecutionTool({
    projectRoot,
    toolName: "run_test",
    description: "Run a project test command locally.",
    schema,
    timeoutMs: 180_000,
    policyTags: ["execution", "test"],
    /** 方法 `resolveCommand`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    resolveCommand(input, root) {
      const cwd = normalizeShellCwd(input.cwd, root);
      return {
        command:
          typeof input.command === "string" && input.command.trim() !== ""
            ? input.command.trim()
            : "npm test",
        cwd,
        timeoutMs: normalizeTimeout(input.timeoutMs, 180_000),
        envAllowlist: [],
        workspaceMount: root,
        networkPolicy: "none",
        profileName: DEFAULT_PROFILE,
      };
    },
  });
}

/**
 * 函数 `createSandboxedNpmTestTool` 的职责说明。
 * `createSandboxedNpmTestTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createSandboxedNpmTestTool(
  projectRoot = resolveProjectRoot()
): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      script: {
        type: "string",
      },
      cwd: {
        type: "string",
      },
      timeoutMs: {
        type: "number",
      },
    },
  } satisfies Record<string, unknown>;

  return createSandboxedExecutionTool({
    projectRoot,
    toolName: "npm_test",
    description: "Run npm test or a named npm script locally.",
    schema,
    timeoutMs: 180_000,
    policyTags: ["execution", "test", "npm"],
    /** 方法 `resolveCommand`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    resolveCommand(input, root) {
      const cwd = normalizeShellCwd(input.cwd, root);
      const script =
        typeof input.script === "string" && input.script.trim() !== ""
          ? input.script.trim()
          : undefined;
      return {
        command: script ? `npm run ${script}` : "npm test",
        cwd,
        timeoutMs: normalizeTimeout(input.timeoutMs, 180_000),
        envAllowlist: [],
        workspaceMount: root,
        networkPolicy: "none",
        profileName: DEFAULT_PROFILE,
      };
    },
  });
}

/**
 * 函数 `createSandboxedBuildTool` 的职责说明。
 * `createSandboxedBuildTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createSandboxedBuildTool(
  projectRoot = resolveProjectRoot()
): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      command: {
        type: "string",
      },
      cwd: {
        type: "string",
      },
      timeoutMs: {
        type: "number",
      },
    },
  } satisfies Record<string, unknown>;

  return createSandboxedExecutionTool({
    projectRoot,
    toolName: "build",
    description: "Run the workspace build command locally.",
    schema,
    timeoutMs: 240_000,
    policyTags: ["execution", "build", "npm"],
    /** 方法 `resolveCommand`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    resolveCommand(input, root) {
      const cwd = normalizeShellCwd(input.cwd, root);
      return {
        command:
          typeof input.command === "string" && input.command.trim() !== ""
            ? input.command.trim()
            : resolveDefaultBuildCommand(root, cwd),
        cwd,
        timeoutMs: normalizeTimeout(input.timeoutMs, 240_000),
        envAllowlist: [],
        workspaceMount: root,
        networkPolicy: "none",
        profileName: DEFAULT_PROFILE,
      };
    },
  });
}

/**
 * 函数 `createSandboxedExecutionTool` 的职责说明。
 * `createSandboxedExecutionTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createSandboxedExecutionTool(
  options: SandboxedExecutionToolOptions
): GatewayTool {
  const projectRoot = options.projectRoot ?? resolveProjectRoot();
  return {
    name: options.toolName,
    description: options.description,
    schema: options.schema,
    inputSchema: options.schema,
    riskLevel: "dangerous",
    permissionLevel: "execute",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    timeoutMs: options.timeoutMs,
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: options.policyTags ?? ["execution"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowNetwork: false,
      allowWrite: true,
      allowHostExecution: true,
      requireApproval: false,
    }),
    sandboxSpec: {
      /** 方法 `resolve`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
      resolve(input: GatewayToolInput) {
        const spec = options.resolveCommand(input, projectRoot);
        return {
          profileName: spec.profileName ?? DEFAULT_PROFILE,
          command: spec.command,
          cwd: spec.cwd,
          projectRoot,
          env: spec.env,
          envAllowlist: spec.envAllowlist,
          timeoutMs: spec.timeoutMs ?? options.timeoutMs,
          workspaceMount: spec.workspaceMount ?? projectRoot,
          networkPolicy: spec.networkPolicy ?? "none",
          resourceLimits: spec.resourceLimits,
        };
      },
    },
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke() {
      return {
        ok: false,
        error: `${options.toolName} must execute through ToolCallExecutor`,
      };
    },
  };
}

/**
 * 函数 `resolveDefaultBuildCommand` 的职责说明。
 * `resolveDefaultBuildCommand` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function resolveDefaultBuildCommand(projectRoot: string, cwd: string): string {
  const packageJsonPath = resolvePackageJsonPath(projectRoot, cwd);
  if (!packageJsonPath) {
    throw new Error(
      "build command not provided and no package.json was found in the requested workspace."
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `failed to read package.json for build detection: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const scripts =
    parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? (parsed.scripts as Record<string, unknown>)
      : {};
  if (typeof scripts.build !== "string" || scripts.build.trim() === "") {
    throw new Error(
      `build command not provided and no build script was found in ${packageJsonPath}.`
    );
  }

  return "npm run build";
}

/**
 * 函数 `resolvePackageJsonPath` 的职责说明。
 * `resolvePackageJsonPath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function resolvePackageJsonPath(projectRoot: string, cwd: string): string | undefined {
  const root = path.resolve(projectRoot);
  let current = path.resolve(cwd);
  while (current.startsWith(root)) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const rootCandidate = path.join(root, "package.json");
  return fs.existsSync(rootCandidate) ? rootCandidate : undefined;
}

/**
 * 函数 `normalizeEnv` 的职责说明。
 * `normalizeEnv` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizeEnv(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && key.trim()) {
      output[key] = value;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

/**
 * 函数 `normalizeShellCwd` 的职责说明。
 * `normalizeShellCwd` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizeShellCwd(input: unknown, projectRoot: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    return projectRoot;
  }

  const trimmed = input.trim();
  if (trimmed === "/workspace") {
    return projectRoot;
  }

  if (trimmed.startsWith("/workspace/")) {
    const relative = trimmed.slice("/workspace/".length).replace(/\//g, "\\");
    return `${projectRoot}\\${relative}`;
  }

  return trimmed;
}

/**
 * 函数 `normalizeTimeout` 的职责说明。
 * `normalizeTimeout` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizeTimeout(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return fallback;
  }

  return Math.floor(input);
}

/**
 * 函数 `requireString` 的职责说明。
 * `requireString` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }

  return value.trim();
}
