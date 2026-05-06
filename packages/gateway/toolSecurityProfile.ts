
import type { GatewayToolPolicy } from "./toolTypes";

export interface ToolSecurityProfile {
  riskLevel: "safe" | "low" | "medium" | "high" | "blocked";
  sandboxRequired: boolean;
  allowNetwork: boolean;
  allowWrite: boolean;
  allowHostExecution: boolean;
  requireApproval: boolean;
}

export interface ToolExecutionDecision {
  action: "host" | "sandbox" | "blocked" | "requireApproval";
  reason: string;
  profile: ToolSecurityProfile;
}

/**
 * 函数 `createToolSecurityProfile` 的职责说明。
 * `createToolSecurityProfile` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createToolSecurityProfile(
  profile: Partial<ToolSecurityProfile> & Pick<ToolSecurityProfile, "riskLevel">
): ToolSecurityProfile {
  return {
    riskLevel: profile.riskLevel,
    sandboxRequired:
      profile.sandboxRequired ??
      (profile.riskLevel === "medium" || profile.riskLevel === "high"),
    allowNetwork: profile.allowNetwork ?? false,
    allowWrite: profile.allowWrite ?? false,
    allowHostExecution: profile.allowHostExecution ?? profile.riskLevel !== "blocked",
    requireApproval:
      profile.requireApproval ??
      (profile.riskLevel === "high" || profile.riskLevel === "blocked"),
  };
}

/**
 * 函数 `securityProfileFromLegacyPolicy` 的职责说明。
 * `securityProfileFromLegacyPolicy` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function securityProfileFromLegacyPolicy(
  policy: GatewayToolPolicy | undefined
): ToolSecurityProfile {
  switch (policy?.riskLevel) {
    case "read-only":
      return createToolSecurityProfile({
        riskLevel: "safe",
        sandboxRequired: false,
        allowHostExecution: true,
      });
    case "external-read":
      return createToolSecurityProfile({
        riskLevel: "low",
        sandboxRequired: false,
        allowHostExecution: true,
        requireApproval: policy.automationLevel !== "auto",
      });
    case "destructive":
      return createToolSecurityProfile({
        riskLevel: "high",
        sandboxRequired: false,
        allowWrite: true,
        allowHostExecution: true,
        requireApproval: true,
      });
    case "stateful":
    default:
      return createToolSecurityProfile({
        riskLevel: "medium",
        sandboxRequired: false,
        allowWrite: true,
        allowHostExecution: true,
        requireApproval:
          policy?.automationLevel === "confirm" ||
          policy?.automationLevel === "manual",
      });
  }
}

/**
 * 函数 `resolveToolSecurityProfile` 的职责说明。
 * `resolveToolSecurityProfile` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function resolveToolSecurityProfile(input: {
  security?: ToolSecurityProfile;
  legacyPolicy?: GatewayToolPolicy;
}): ToolSecurityProfile {
  if (input.security) {
    return createToolSecurityProfile(input.security);
  }

  return securityProfileFromLegacyPolicy(input.legacyPolicy);
}

/**
 * 函数 `decideToolExecution` 的职责说明。
 * `decideToolExecution` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function decideToolExecution(input: {
  profile: ToolSecurityProfile;
  hasSandboxSpec: boolean;
  approved?: boolean;
}): ToolExecutionDecision {
  const { profile, hasSandboxSpec, approved } = input;

  if (profile.riskLevel === "blocked") {
    return {
      action: "blocked",
      reason: "tool is blocked by security policy",
      profile,
    };
  }

  if (profile.requireApproval && !approved) {
    return {
      action: "requireApproval",
      reason: "tool execution requires approval",
      profile,
    };
  }

  if (!profile.allowHostExecution) {
    return {
      action: "blocked",
      reason: "tool is not allowed to run on the host",
      profile,
    };
  }

  return {
    action: "host",
    reason: "tool allowed on host",
    profile,
  };
}
