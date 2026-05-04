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

export function resolveToolSecurityProfile(input: {
  security?: ToolSecurityProfile;
  legacyPolicy?: GatewayToolPolicy;
}): ToolSecurityProfile {
  if (input.security) {
    return createToolSecurityProfile(input.security);
  }

  return securityProfileFromLegacyPolicy(input.legacyPolicy);
}

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
