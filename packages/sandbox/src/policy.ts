import type { GatewayToolPolicy } from "../../gateway/toolTypes";
import type {
  SandboxConfig,
  SandboxExecRequest,
  ToolExecutionDecision,
  ToolRiskLevel,
  ToolSecurityProfile,
} from "./types";

interface BlockedPattern {
  pattern: RegExp;
  reason: string;
}

const BLOCKED_COMMAND_PATTERNS: BlockedPattern[] = [
  { pattern: /\bsudo\b/i, reason: "sudo is blocked" },
  { pattern: /\bsu\s+-/i, reason: "su - is blocked" },
  { pattern: /chmod\s+777\s+\//i, reason: "chmod 777 / is blocked" },
  { pattern: /rm\s+-rf\s+\//i, reason: "rm -rf / is blocked" },
  { pattern: /\bmkfs\b/i, reason: "mkfs is blocked" },
  { pattern: /\bmount\b/i, reason: "mount is blocked" },
  { pattern: /\bumount\b/i, reason: "umount is blocked" },
  { pattern: /\bdd\s+if=/i, reason: "dd if= is blocked" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: "fork bomb pattern is blocked" },
  { pattern: /docker\.sock/i, reason: "docker socket access is blocked" },
  { pattern: /--privileged\b/i, reason: "privileged containers are blocked" },
  { pattern: /--network\s+host\b/i, reason: "host network is blocked" },
  { pattern: /\/var\/run\/docker\.sock/i, reason: "docker socket mount is blocked" },
  { pattern: /~\/\.ssh/i, reason: "~/.ssh access is blocked" },
  { pattern: /~\/\.aws/i, reason: "~/.aws access is blocked" },
  { pattern: /~\/\.docker/i, reason: "~/.docker access is blocked" },
  { pattern: /(^|\s)\.env(\s|$)/i, reason: ".env access is blocked" },
  { pattern: /\bcurl\b[\s\S]*\|\s*sh\b/i, reason: "curl | sh is blocked" },
  { pattern: /\bwget\b[\s\S]*\|\s*sh\b/i, reason: "wget | sh is blocked" },
];

export function createToolSecurityProfile(
  profile: Partial<ToolSecurityProfile> & Pick<ToolSecurityProfile, "riskLevel">
): ToolSecurityProfile {
  return {
    riskLevel: profile.riskLevel,
    sandboxRequired:
      profile.sandboxRequired ?? (profile.riskLevel === "medium" || profile.riskLevel === "high"),
    allowNetwork: profile.allowNetwork ?? false,
    allowWrite: profile.allowWrite ?? false,
    allowHostExecution: profile.allowHostExecution ?? profile.riskLevel !== "blocked",
    requireApproval:
      profile.requireApproval ?? (profile.riskLevel === "high" || profile.riskLevel === "blocked"),
  };
}

export function securityProfileFromLegacyPolicy(
  policy: GatewayToolPolicy | undefined
): ToolSecurityProfile {
  const riskLevel = mapLegacyRiskLevel(policy?.riskLevel);

  switch (riskLevel) {
    case "safe":
      return createToolSecurityProfile({
        riskLevel,
        sandboxRequired: false,
        allowWrite: false,
        allowHostExecution: true,
        requireApproval: false,
      });
    case "low":
      return createToolSecurityProfile({
        riskLevel,
        sandboxRequired: false,
        allowWrite: false,
        allowHostExecution: true,
        requireApproval: policy?.automationLevel === "confirm" || policy?.automationLevel === "manual",
      });
    case "medium":
      return createToolSecurityProfile({
        riskLevel,
        sandboxRequired: true,
        allowWrite: true,
        allowHostExecution: true,
        requireApproval: policy?.automationLevel === "confirm" || policy?.automationLevel === "manual",
      });
    case "high":
      return createToolSecurityProfile({
        riskLevel,
        sandboxRequired: true,
        allowWrite: true,
        allowHostExecution: true,
        requireApproval: true,
      });
    case "blocked":
      return createToolSecurityProfile({
        riskLevel,
        sandboxRequired: false,
        allowWrite: false,
        allowHostExecution: false,
        requireApproval: true,
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
  config: SandboxConfig;
  profile: ToolSecurityProfile;
  hasSandboxSpec: boolean;
  approved?: boolean;
}): ToolExecutionDecision {
  const { config, profile, hasSandboxSpec, approved } = input;

  if (profile.riskLevel === "blocked" || !profile.allowHostExecution && !hasSandboxSpec) {
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

  if (!config.enabled || config.mode === "off") {
    if (!profile.allowHostExecution) {
      return {
        action: "blocked",
        reason: "tool is not allowed to execute on the host when sandbox is disabled",
        profile,
      };
    }

    return {
      action: "host",
      reason: "sandbox disabled",
      profile,
    };
  }

  if (profile.sandboxRequired) {
    if (!hasSandboxSpec) {
      return profile.allowHostExecution
        ? {
            action: "host",
            reason: "tool requires sandbox but has no sandbox spec; falling back to host execution",
            profile,
          }
        : {
            action: "blocked",
            reason: "tool requires sandbox but no sandbox spec is available",
            profile,
          };
    }

    return {
      action: "sandbox",
      reason: "tool requires sandbox execution",
      profile,
    };
  }

  if (config.mode === "all" && hasSandboxSpec) {
    return {
      action: "sandbox",
      reason: "sandbox mode=all routes sandbox-capable tools into the container",
      profile,
    };
  }

  return {
    action: "host",
    reason: "tool allowed on host",
    profile,
  };
}

export function findBlockedCommandReason(
  request: Pick<SandboxExecRequest, "command" | "args">
): string | undefined {
  const commandLine = [request.command, ...request.args].join(" ").trim();

  for (const blocked of BLOCKED_COMMAND_PATTERNS) {
    if (blocked.pattern.test(commandLine)) {
      return blocked.reason;
    }
  }

  return undefined;
}

function mapLegacyRiskLevel(
  riskLevel: GatewayToolPolicy["riskLevel"] | undefined
): ToolRiskLevel {
  switch (riskLevel) {
    case "read-only":
      return "safe";
    case "external-read":
      return "low";
    case "stateful":
      return "medium";
    case "destructive":
      return "high";
    default:
      return "medium";
  }
}
