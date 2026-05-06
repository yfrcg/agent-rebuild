
import * as path from "node:path";

import type { GatewayTool } from "./toolTypes";
import type { GatewayMcpServerConfig } from "./mcpTypes";
import { resolveToolSecurityProfile } from "./toolSecurityProfile";
import type { ToolSecurityProfile } from "./toolSecurityProfile";
import { assertInsideWorkspace, isDangerousHostPath } from "./pathGuard";

export type GatewaySandboxMode = "off" | "workspace-write" | "read-only";

export interface GatewaySandboxDecision {
  allowed: boolean;
  reason?: string;
}

export interface GatewaySandboxOptions {
  mode?: GatewaySandboxMode;
  allowedRoots?: string[];
}

export class GatewaySandbox {
  readonly mode: GatewaySandboxMode;
  readonly allowedRoots: string[];

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(
    modeOrOptions: GatewaySandboxMode | GatewaySandboxOptions = "off",
    allowedRoots: string[] = []
  ) {
    if (typeof modeOrOptions === "string") {
      this.mode = modeOrOptions;
      this.allowedRoots = allowedRoots.map((root) => path.resolve(root));
      return;
    }

    this.mode = modeOrOptions.mode ?? "off";
    this.allowedRoots = (modeOrOptions.allowedRoots ?? []).map((root) => path.resolve(root));
  }

  /**
   * 方法 `canWriteMemory` 的职责说明。
   * `canWriteMemory` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  canWriteMemory(action: string): GatewaySandboxDecision {
    if (this.mode !== "read-only") {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `[guard] blocked ${action}: read-only mode forbids memory mutations.`,
    };
  }

  /**
   * 方法 `canExecuteTool` 的职责说明。
   * `canExecuteTool` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  canExecuteTool(tool: GatewayTool | undefined): GatewaySandboxDecision {
    if (!tool || this.mode === "off") {
      return { allowed: true };
    }

    const riskLevel = tool.policy?.riskLevel ?? "stateful";

    if (riskLevel === "destructive") {
      return {
        allowed: false,
        reason: `[guard] blocked tool ${tool.name}: destructive tools require GATEWAY_SANDBOX_MODE=off.`,
      };
    }

    if (this.mode === "read-only" && riskLevel === "stateful") {
      return {
        allowed: false,
        reason: `[guard] blocked tool ${tool.name}: read-only mode forbids stateful tools.`,
      };
    }

    if (this.mode === "workspace-write" && riskLevel === "stateful") {
      return {
        allowed: false,
        reason: `[guard] blocked tool ${tool.name}: workspace-write mode only allows read-only and external-read tools.`,
      };
    }

    return { allowed: true };
  }

  /**
   * 方法 `canUseToolInputPaths` 的职责说明。
   * `canUseToolInputPaths` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  canUseToolInputPaths(input: Record<string, unknown>): GatewaySandboxDecision {
    if (this.mode === "off" || this.allowedRoots.length === 0) {
      return { allowed: true };
    }

    const candidatePaths = collectPathLikeValues(input);
    for (const candidate of candidatePaths) {
      const normalized = resolveCandidatePath(candidate);
      if (!normalized || /^[a-z]+:\/\//i.test(candidate.trim())) {
        continue;
      }

      if (isDangerousHostPath(normalized)) {
        return {
          allowed: false,
          reason: `[guard] blocked dangerous path input: ${candidate}`,
        };
      }

      const isInsideAnyRoot = this.allowedRoots.some((root) => {
        try {
          assertInsideWorkspace(normalized, root);
          return true;
        } catch {
          return false;
        }
      });

      if (!isInsideAnyRoot) {
        return {
          allowed: false,
          reason: `[guard] blocked path input: ${candidate} is outside allowed roots.`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * 方法 `requiresConfirmation` 的职责说明。
   * `requiresConfirmation` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  requiresConfirmation(tool: GatewayTool | undefined): boolean {
    if (!tool) {
      return false;
    }

    if (tool.policy?.riskLevel === "destructive") {
      return true;
    }

    const security = this.getToolSecurityProfile(tool);
    return (
      security.requireApproval ||
      tool.policy?.automationLevel === "confirm" ||
      tool.policy?.automationLevel === "manual"
    );
  }

  /**
   * 方法 `getToolSecurityProfile` 的职责说明。
   * `getToolSecurityProfile` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  getToolSecurityProfile(tool: GatewayTool | undefined): ToolSecurityProfile {
    return resolveToolSecurityProfile({
      security: tool?.security,
      legacyPolicy: tool?.policy,
    });
  }

  /**
   * 方法 `canConnectMcpServer` 的职责说明。
   * `canConnectMcpServer` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  canConnectMcpServer(config: GatewayMcpServerConfig): GatewaySandboxDecision {
    if (this.mode === "off") {
      return { allowed: true };
    }

    if (!config.isolation?.enabled || config.isolation.mode !== "restricted") {
      return {
        allowed: false,
        reason: `[guard] blocked MCP server ${config.id}: sandboxed mode requires isolation.enabled=true and isolation.mode=restricted.`,
      };
    }

    const runtimeRoot = config.isolation.runtimeRoot;
    if (!runtimeRoot) {
      return {
        allowed: false,
        reason: `[guard] blocked MCP server ${config.id}: restricted isolation requires an explicit runtimeRoot.`,
      };
    }

    const runtimeDecision = this.canUseToolInputPaths({
      runtimeRoot,
    });
    if (!runtimeDecision.allowed) {
      return {
        allowed: false,
        reason: `[guard] blocked MCP server ${config.id}: runtimeRoot must stay within allowed roots.`,
      };
    }

    return { allowed: true };
  }
}

/**
 * 函数 `collectPathLikeValues` 的职责说明。
 * `collectPathLikeValues` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function collectPathLikeValues(input: unknown, keyHint = ""): string[] {
  if (typeof input === "string") {
    return isPathLikeKey(keyHint) ? [input] : [];
  }

  if (Array.isArray(input)) {
    return input.flatMap((item) => collectPathLikeValues(item, keyHint));
  }

  if (!input || typeof input !== "object") {
    return [];
  }

  return Object.entries(input as Record<string, unknown>).flatMap(([key, value]) =>
    collectPathLikeValues(value, key)
  );
}

/**
 * 函数 `isPathLikeKey` 的职责说明。
 * `isPathLikeKey` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function isPathLikeKey(key: string): boolean {
  return /(path|file|dir|cwd|root|workspace)/i.test(key);
}

/**
 * 函数 `resolveCandidatePath` 的职责说明。
 * `resolveCandidatePath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function resolveCandidatePath(candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    return path.resolve(trimmed);
  }

  if (/^[a-z]+:\/\//i.test(trimmed)) {
    return undefined;
  }

  return path.resolve(process.cwd(), trimmed);
}
