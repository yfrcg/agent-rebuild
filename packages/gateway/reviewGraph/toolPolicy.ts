/**
 * ?????CS336 ???
 * ???packages/gateway/reviewGraph/toolPolicy.ts
 * ???? Agent ?????
 * ??????? Explore?Plan?Implement?Test?Verify?Security?Reviewer ?????
 * ???????????????????????????????????? README ????????????????
 */

import * as path from "node:path";

import type { AgentDefinition, ReviewGraphState, ToolPolicyCheck } from "./types";

const SENSITIVE_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".ssh",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "token",
  "credential",
  "credentials",
  "secret",
  "private_key",
  "private.key",
  ".npmrc",
  ".gitconfig",
];

const DANGEROUS_COMMANDS = [
  /rm\s+-rf/i,
  /rm\s+-fr/i,
  /sudo\s/i,
  /git\s+push/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean/i,
  /npm\s+publish/i,
  /curl.*\|\s*(?:ba)?sh/i,
  /wget.*\|\s*(?:ba)?sh/i,
  /chmod\s+777/i,
  /del\s+\/[sfq]/i,
  /rmdir\s+\/s/i,
  /Remove-Item/i,
  /Invoke-Expression/i,
  /Invoke-WebRequest/i,
  /Start-BitsTransfer/i,
  /New-Object\s+Net\.WebClient/i,
];

const FILE_WRITE_TOOLS = [
  "file.write",
  "file.edit",
  "file.multi_edit",
  "file.patch",
];

const FILE_READ_TOOLS = [
  "file.read",
  "file.glob",
  "file.grep",
  "file.list",
];

const SHELL_TOOLS = ["shell.run", "bash.run"];

const NETWORK_TOOLS = ["web.fetch", "web.search"];

const DELETE_PATTERNS = [
  /file\.delete/i,
  /rm\s/i,
  /del\s/i,
  /Remove-Item/i,
  /unlink/i,
];

/**
 * 函数 `isSensitivePath` 的职责说明。
 * `isSensitivePath` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const basename = path.basename(normalized);
  return SENSITIVE_PATHS.some(
    (sensitive) =>
      normalized.includes(`/${sensitive}`) ||
      normalized.includes(`\\${sensitive}`) ||
      normalized.endsWith(sensitive) ||
      basename === sensitive
  );
}

/**
 * 函数 `isDangerousCommand` 的职责说明。
 * `isDangerousCommand` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMANDS.some((pattern) => pattern.test(command));
}

/**
 * 函数 `isDeleteOperation` 的职责说明。
 * `isDeleteOperation` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function isDeleteOperation(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === "file.delete") return true;
  if (SHELL_TOOLS.includes(toolName)) {
    const cmd = String(args.command || args.cmd || "");
    return DELETE_PATTERNS.some((pattern) => pattern.test(cmd));
  }
  return false;
}

/**
 * 函数 `isGitPush` 的职责说明。
 * `isGitPush` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function isGitPush(toolName: string, args: Record<string, unknown>): boolean {
  if (SHELL_TOOLS.includes(toolName)) {
    const cmd = String(args.command || args.cmd || "");
    return /git\s+push/i.test(cmd);
  }
  return false;
}

/**
 * 函数 `extractFilePaths` 的职责说明。
 * `extractFilePaths` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function extractFilePaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof args.path === "string") paths.push(args.path);
  if (typeof args.filePath === "string") paths.push(args.filePath);
  if (typeof args.file === "string") paths.push(args.file);
  if (typeof args.targetFile === "string") paths.push(args.targetFile);
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === "string") paths.push(p);
    }
  }
  return paths;
}

export interface CheckToolPolicyParams {
  agentDef: AgentDefinition;
  toolName: string;
  args: Record<string, unknown>;
  state: ReviewGraphState;
  workspaceRoot: string;
}

/**
 * 函数 `checkToolPolicy` 的职责说明。
 * `checkToolPolicy` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function checkToolPolicy(params: CheckToolPolicyParams): ToolPolicyCheck {
  const { agentDef, toolName, args, state, workspaceRoot } = params;
  const violations: string[] = [];

  if (agentDef.deniedTools.includes(toolName)) {
    violations.push(`Tool "${toolName}" is in deniedTools list`);
    return { allowed: false, reason: "denied_tool", violations };
  }

  if (!agentDef.allowedTools.includes(toolName)) {
    violations.push(`Tool "${toolName}" is not in allowedTools list`);
    return { allowed: false, reason: "not_allowed_tool", violations };
  }

  if (!agentDef.canSpawnAgents && toolName === "agent.spawn") {
    violations.push("Agent cannot spawn sub-agents (canSpawnAgents=false)");
    return { allowed: false, reason: "spawn_disabled", violations };
  }

  const filePaths = extractFilePaths(args);
  if (
    agentDef.node === "implement" &&
    FILE_WRITE_TOOLS.includes(toolName) &&
    state.targetFiles &&
    state.targetFiles.length > 0
  ) {
    for (const fp of filePaths) {
      const normalized = fp.replace(/\\/g, "/");
      const isInTarget = state.targetFiles.some(
        (target) =>
          normalized.includes(target) || target.includes(normalized)
      );
      if (!isInTarget) {
        violations.push(
          `Implement Agent cannot modify "${fp}" (not in targetFiles)`
        );
      }
    }
    if (violations.length > 0) {
      return { allowed: false, reason: "target_file_violation", violations };
    }
  }

  for (const fp of filePaths) {
    if (isSensitivePath(fp)) {
      violations.push(`Access to sensitive file "${fp}" is denied`);
    }
  }
  if (violations.length > 0) {
    return { allowed: false, reason: "sensitive_file", violations };
  }

  for (const fp of filePaths) {
    const resolved = path.resolve(workspaceRoot, fp);
    if (!resolved.startsWith(workspaceRoot)) {
      violations.push(`Path "${fp}" escapes workspace boundary`);
    }
  }
  if (violations.length > 0) {
    return { allowed: false, reason: "path_escape", violations };
  }

  if (SHELL_TOOLS.includes(toolName)) {
    const cmd = String(args.command || args.cmd || "");
    if (isDangerousCommand(cmd)) {
      violations.push(`Dangerous shell command detected: "${cmd.slice(0, 100)}"`);
      return { allowed: false, reason: "dangerous_command", violations };
    }
  }

  if (isDeleteOperation(toolName, args)) {
    violations.push("File deletion is not allowed for this agent");
    return { allowed: false, reason: "delete_operation", violations };
  }

  if (isGitPush(toolName, args)) {
    violations.push("git push is not allowed");
    return { allowed: false, reason: "git_push", violations };
  }

  if (
    NETWORK_TOOLS.includes(toolName) &&
    !agentDef.allowedTools.includes(toolName)
  ) {
    violations.push("Network access is not allowed for this agent");
    return { allowed: false, reason: "network_access", violations };
  }

  return { allowed: true, violations: [] };
}

/**
 * 函数 `createRestrictedAgentDefinition` 的职责说明。
 * `createRestrictedAgentDefinition` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createRestrictedAgentDefinition(
  base: AgentDefinition,
  overrides: Partial<AgentDefinition>
): AgentDefinition {
  return { ...base, ...overrides };
}
