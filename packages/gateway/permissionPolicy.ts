/**
 * ?????CS336 ???
 * ???packages/gateway/permissionPolicy.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import * as path from "node:path";

import type { GatewayPlanState, GatewayPermissionDecision, GatewayPermissionMode } from "./permissionTypes";
import type { GatewayToolCallRequest, GatewayProjectBoundary } from "./toolCallTypes";
import type { GatewayTool } from "./toolTypes";

export interface PermissionPolicyOptions {
  projectRoot: string;
  allowBypassPermissions?: boolean;
}

export class PermissionPolicy {
  private readonly projectRoot: string;
  private readonly allowBypassPermissions: boolean;

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(options: PermissionPolicyOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.allowBypassPermissions =
      options.allowBypassPermissions ?? isTruthyEnv("GATEWAY_ALLOW_BYPASS_PERMISSIONS");
  }

  /**
   * 方法 `evaluate` 的职责说明。
   * `evaluate` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  evaluate(input: {
    tool: GatewayTool | undefined;
    request: GatewayToolCallRequest;
    mode?: GatewayPermissionMode;
    plan?: GatewayPlanState;
  }): GatewayPermissionDecision {
    const tool = input.tool;
    const toolName = input.request.toolName;
    const mode = input.mode ?? "default";
    const requiresSandbox = tool?.requiresSandbox ?? false;

    const sensitivePath = this.findSensitivePath(input.request.input);
    if (sensitivePath) {
      return deny(mode, requiresSandbox, `sensitive path access blocked: ${sensitivePath}`, "sensitive-path");
    }

    const outsideWorkspacePath = this.findOutsideWorkspacePath(
      input.request.input,
      input.request.projectBoundary,
      tool?.readOnly ?? false
    );
    if (outsideWorkspacePath) {
      return deny(mode, requiresSandbox, `path escapes workspace: ${outsideWorkspacePath}`, "workspace-boundary");
    }

    if (mode === "bypassPermissions") {
      if (!this.allowBypassPermissions) {
        return deny(
          mode,
          requiresSandbox,
          "bypassPermissions is disabled. Set GATEWAY_ALLOW_BYPASS_PERMISSIONS=true to enable it explicitly.",
          "mode:bypassPermissions-disabled"
        );
      }
      return allow(mode, requiresSandbox, "bypassPermissions enabled", "mode:bypassPermissions");
    }

    if (mode === "plan") {
      return this.evaluatePlanMode(input.tool, input.request, input.plan, requiresSandbox);
    }

    const isReadOnly = tool?.readOnly ?? false;
    const permissionLevel = tool?.permissionLevel ?? "advanced";

    if (isReadOnly && permissionLevel === "read") {
      return allow(mode, requiresSandbox, "read-only tool allowed", "read-only");
    }

    if (permissionLevel === "plan") {
      return allow(mode, requiresSandbox, "planning tool allowed", "planning");
    }

    if (permissionLevel === "write") {
      if (this.isProjectWriteAllowed(input.request)) {
        return allow(
          mode,
          requiresSandbox,
          "file edit allowed inside bound project write roots",
          "project-boundary:write"
        );
      }

      if (mode === "acceptEdits" || input.request.approved) {
        return allow(
          mode,
          requiresSandbox,
          mode === "acceptEdits" ? "file edits allowed in acceptEdits mode" : "explicit approval present",
          mode === "acceptEdits" ? "mode:acceptEdits" : "explicit-approval"
        );
      }

      return deny(
        mode,
        requiresSandbox,
        "write tool blocked. Use acceptEdits mode or explicit approval.",
        "write-approval-required"
      );
    }

    if (permissionLevel === "execute") {
      const command = readCommand(input.request.input);
      if (command && isDangerousCommand(command)) {
        return deny(mode, requiresSandbox, `dangerous command blocked: ${command}`, "dangerous-command");
      }

      if (mode === "dontAsk") {
        return deny(mode, requiresSandbox, "execution blocked in dontAsk mode", "mode:dontAsk");
      }

      if (input.request.approved) {
        return allow(mode, requiresSandbox, "explicit approval present", "explicit-approval");
      }

      return deny(
        mode,
        requiresSandbox,
        "execution tool blocked. Run it explicitly or change permission mode.",
        "execution-approval-required"
      );
    }

    if (mode === "dontAsk") {
      return deny(mode, requiresSandbox, "tool blocked in dontAsk mode", "mode:dontAsk");
    }

    return deny(mode, requiresSandbox, `tool requires a stronger permission mode: ${toolName}`, "permission-level");
  }

  private isProjectWriteAllowed(request: GatewayToolCallRequest): boolean {
    const boundary = request.projectBoundary;
    if (boundary?.permission !== "project-write" || !boundary.projectDir) {
      return false;
    }

    const requestedPath = readPath(request.input);
    if (!requestedPath) {
      return false;
    }

    const baseRoot = path.resolve(boundary.projectDir);
    const resolved = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(baseRoot, requestedPath);

    return boundary.allowedWriteRoots.some((root) => {
      const writeRoot = path.resolve(root);
      return resolved === writeRoot || resolved.startsWith(writeRoot + path.sep);
    });
  }

  /**
   * 方法 `evaluatePlanMode` 的职责说明。
   * `evaluatePlanMode` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private evaluatePlanMode(
    tool: GatewayTool | undefined,
    request: GatewayToolCallRequest,
    plan: GatewayPlanState | undefined,
    requiresSandbox: boolean
  ): GatewayPermissionDecision {
    const mode: GatewayPermissionMode = "plan";
    const permissionLevel = tool?.permissionLevel ?? "advanced";
    const isReadOnly = tool?.readOnly ?? false;

    if (permissionLevel === "plan" || (permissionLevel === "read" && isReadOnly)) {
      return allow(mode, requiresSandbox, "plan mode read access allowed", "mode:plan");
    }

    if (permissionLevel === "write") {
      const requestedPath = readPath(request.input);
      if (plan?.planPath && requestedPath && normalizeComparablePath(requestedPath) === normalizeComparablePath(plan.planPath)) {
        return allow(mode, requiresSandbox, "plan file write allowed in plan mode", "mode:plan-plan-file");
      }
    }

    return deny(mode, requiresSandbox, `tool blocked in plan mode: ${request.toolName}`, "mode:plan");
  }

  /**
   * 方法 `findSensitivePath` 的职责说明。
   * `findSensitivePath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private findSensitivePath(input: Record<string, unknown>): string | undefined {
    return collectPaths(input).find((candidate) => SENSITIVE_PATH_PATTERN.test(candidate));
  }

  /**
   * 方法 `findOutsideWorkspacePath` 的职责说明。
   * `findOutsideWorkspacePath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private findOutsideWorkspacePath(
    input: Record<string, unknown>,
    boundary?: GatewayProjectBoundary,
    toolReadOnly?: boolean
  ): string | undefined {
    const effectiveRoots: string[] = [];
    if (boundary?.permission === "project-write" && boundary.projectDir) {
      effectiveRoots.push(path.resolve(boundary.projectDir));
      for (const root of boundary.allowedReadRoots) {
        const resolved = path.resolve(root);
        if (!effectiveRoots.includes(resolved)) {
          effectiveRoots.push(resolved);
        }
      }
    }
    if (effectiveRoots.length === 0) {
      effectiveRoots.push(this.projectRoot);
    }

    for (const candidate of collectPaths(input)) {
      if (!looksLikeLocalPath(candidate)) {
        continue;
      }

      const baseRoot =
        boundary?.permission === "project-write" && boundary.projectDir
          ? boundary.projectDir
          : this.projectRoot;
      const resolved = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(baseRoot, candidate);
      const isInsideAnyRoot = effectiveRoots.some(
        (root) => resolved === root || resolved.startsWith(root + path.sep)
      );
      if (!isInsideAnyRoot) {
        if (toolReadOnly && boundary?.permission === "project-write") {
          if (SENSITIVE_PATH_PATTERN.test(candidate)) {
            return candidate;
          }
          continue;
        }
        return candidate;
      }
    }

    return undefined;
  }
}

const SENSITIVE_PATH_PATTERN =
  /(^|[\\/])(\.env(\..+)?|credentials?|tokens?|secrets?|id_rsa|id_ed25519|authorized_keys)([\\/]|$)/i;

const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bchmod\b.+\b(777|666)\b/i,
  /\bchown\b/i,
  /\bmkfs\b/i,
  /\bdd\b/i,
  /\bkill(all)?\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fd\b/i,
  /\bgit\s+push\b/i,
  /\bcurl\b.+\b(-F|--form|--upload-file)\b/i,
  /\bwget\b.+\b(--post-file|--body-file)\b/i,
  /\bRemove-Item\b/i,
  /\bdel\b/i,
  /\brmdir\b/i,
  /\bformat\b/i,
];

/**
 * 函数 `allow` 的职责说明。
 * `allow` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function allow(
  mode: GatewayPermissionMode,
  requiresSandbox: boolean,
  reason: string,
  matchedRule: string
): GatewayPermissionDecision {
  return {
    action: "allow",
    mode,
    reason,
    requiresSandbox,
    matchedRule,
  };
}

/**
 * 函数 `deny` 的职责说明。
 * `deny` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function deny(
  mode: GatewayPermissionMode,
  requiresSandbox: boolean,
  reason: string,
  matchedRule: string
): GatewayPermissionDecision {
  return {
    action: "deny",
    mode,
    reason,
    requiresSandbox,
    matchedRule,
  };
}

/**
 * 函数 `collectPaths` 的职责说明。
 * `collectPaths` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function collectPaths(input: Record<string, unknown>): string[] {
  return Object.entries(input).flatMap(([key, value]) => {
    if (!/(path|file|cwd|dir|root|workspace)/i.test(key)) {
      return [];
    }

    if (typeof value === "string") {
      return [value];
    }

    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }

    return [];
  });
}

/**
 * 函数 `readPath` 的职责说明。
 * `readPath` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function readPath(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "filePath", "cwd"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

/**
 * 函数 `readCommand` 的职责说明。
 * `readCommand` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function readCommand(input: Record<string, unknown>): string | undefined {
  const value = input.command;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * 函数 `isDangerousCommand` 的职责说明。
 * `isDangerousCommand` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * 函数 `looksLikeLocalPath` 的职责说明。
 * `looksLikeLocalPath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function looksLikeLocalPath(candidate: string): boolean {
  return (
    candidate.includes("\\") ||
    candidate.includes("/") ||
    candidate.startsWith(".") ||
    /^[A-Za-z]:[\\/]/.test(candidate)
  );
}

/**
 * 函数 `normalizeComparablePath` 的职责说明。
 * `normalizeComparablePath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizeComparablePath(value: string): string {
  return path.resolve(value).toLowerCase();
}

/**
 * 函数 `isTruthyEnv` 的职责说明。
 * `isTruthyEnv` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function isTruthyEnv(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return ["true", "1", "yes", "y", "on"].includes(raw.trim().toLowerCase());
}
