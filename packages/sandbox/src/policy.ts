import type { GatewayToolPolicy } from "../../gateway/toolTypes";
import type {
  PolicyDecision,
  SandboxProfile,
  SandboxProfileName,
  SandboxRequest,
  ToolExecutionDecision,
  ToolSecurityProfile,
} from "./types";

interface PolicyRule {
  action: PolicyDecision["action"];
  matcher: RuleMatcher;
  pattern: string;
  reason: string;
}

interface RuleContext {
  toolName: string;
  command: string;
}

type RuleMatcher = (context: RuleContext) => boolean;

export const DEFAULT_SANDBOX_PROFILES: Record<SandboxProfileName, SandboxProfile> = {
  plan: {
    name: "plan",
    network: "none",
    workspaceAccess: "none",
    timeoutMs: 10_000,
    memoryMb: 512,
    cpus: 1,
    pidsLimit: 64,
  },
  "safe-dev": {
    name: "safe-dev",
    network: "none",
    workspaceAccess: "rw",
    timeoutMs: 30_000,
    memoryMb: 1024,
    cpus: 1,
    pidsLimit: 128,
  },
  elevated: {
    name: "elevated",
    network: "restricted",
    workspaceAccess: "rw",
    timeoutMs: 60_000,
    memoryMb: 2048,
    cpus: 2,
    pidsLimit: 256,
    requireHumanApproval: true,
  },
};

export class ToolPolicyEngine {
  private readonly denyRules: PolicyRule[];
  private readonly askRules: PolicyRule[];
  private readonly allowRules: PolicyRule[];

  constructor() {
    this.denyRules = createDefaultDenyRules();
    this.askRules = createDefaultAskRules();
    this.allowRules = createDefaultAllowRules();
  }

  decide(request: SandboxRequest, profile: SandboxProfile): PolicyDecision {
    const command = normalizeCommand(request.command);
    const toolName = request.toolName.trim();
    const context: RuleContext = {
      toolName,
      command,
    };

    if (profile.name === "plan" && blocksPlanTool(toolName)) {
      return {
        action: "deny",
        reason: `profile ${profile.name} does not permit ${toolName}`,
        matchedRule: "Plan(tool mutation blocked)",
      };
    }

    for (const rule of this.denyRules) {
      if (rule.matcher(context)) {
        return {
          action: "deny",
          reason: rule.reason,
          matchedRule: rule.pattern,
        };
      }
    }

    if (profile.requireHumanApproval) {
      return {
        action: "ask",
        reason: `profile ${profile.name} requires human approval`,
        matchedRule: `Profile(${profile.name})`,
      };
    }

    for (const rule of this.askRules) {
      if (rule.matcher(context)) {
        return {
          action: "ask",
          reason: rule.reason,
          matchedRule: rule.pattern,
        };
      }
    }

    for (const rule of this.allowRules) {
      if (rule.matcher(context)) {
        return {
          action: "allow",
          reason: rule.reason,
          matchedRule: rule.pattern,
        };
      }
    }

    if (
      isExecutionToolName(toolName)
    ) {
      return {
        action: "allow",
        reason: "default sandboxed bash execution allowed by profile",
        matchedRule: `Tool(${toolName})`,
      };
    }

    return {
      action: "deny",
      reason: "no matching allow rule",
      matchedRule: "default-deny",
    };
  }
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
        sandboxRequired: true,
        allowWrite: true,
        allowHostExecution: false,
        requireApproval: true,
      });
    case "stateful":
    default:
      return createToolSecurityProfile({
        riskLevel: "medium",
        sandboxRequired: true,
        allowWrite: true,
        allowHostExecution: false,
        requireApproval: policy?.automationLevel === "confirm" || policy?.automationLevel === "manual",
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

  if (profile.sandboxRequired) {
    if (!hasSandboxSpec) {
      return {
        action: "blocked",
        reason: "tool requires sandbox execution but does not provide a sandbox spec",
        profile,
      };
    }

    return {
      action: "sandbox",
      reason: "tool requires sandbox execution",
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

function createDefaultDenyRules(): PolicyRule[] {
  return [
    bashRule("rm -rf /", /(^|\s)rm\s+-rf\s+\/(\s|$)/i, "dangerous root deletion is denied"),
    bashRule("rm -rf ~", /(^|\s)rm\s+-rf\s+~([/\\]|\s|$)/i, "home deletion is denied"),
    bashRule("sudo *", /(^|\s)sudo(\s|$)/i, "sudo is denied"),
    bashRule("docker *", /(^|\s)docker(\s|$)/i, "docker nesting is denied"),
    bashRule("curl * | sh", /\bcurl\b[\s\S]*\|\s*(sh|bash)\b/i, "curl pipe shell bootstrap is denied"),
    bashRule("wget * | sh", /\bwget\b[\s\S]*\|\s*(sh|bash)\b/i, "wget pipe shell bootstrap is denied"),
    bashRule("chmod 777 *", /\bchmod\s+777\b/i, "chmod 777 is denied"),
    bashRule("chown *", /\bchown\b/i, "chown is denied"),
    pathRule("Read(~/.ssh/**)", "file.read", "~/.ssh", "reading ~/.ssh is denied"),
    commandContainsRule("Read(~/.ssh/**)", "~/.ssh", "reading ~/.ssh is denied"),
    envFileRule("Read(**/.env*)", "reading .env files is denied"),
    pathRule("Write(~/**)", "file.write", "~", "writing under home is denied"),
    toolRule("Network(*)", "network.request", "direct network tools are denied"),
  ];
}

function createDefaultAskRules(): PolicyRule[] {
  return [
    bashRule("npm install *", /\bnpm\s+install\b/i, "dependency installation requires approval"),
    bashRule("pnpm install *", /\bpnpm\s+install\b/i, "dependency installation requires approval"),
    bashRule("yarn install *", /\byarn\s+install\b/i, "dependency installation requires approval"),
    bashRule("pip install *", /\bpip\s+install\b/i, "dependency installation requires approval"),
    bashRule("uv sync *", /\buv\s+sync\b/i, "dependency synchronization requires approval"),
    bashRule("git commit *", /\bgit\s+commit\b/i, "git commit requires approval"),
    bashRule("git push *", /\bgit\s+push\b/i, "git push requires approval"),
  ];
}

function createDefaultAllowRules(): PolicyRule[] {
  return [
    bashRule("npm test*", /\bnpm\s+test\b/i, "npm test is allowed"),
    bashRule("npm run test*", /\bnpm\s+run\s+test\b/i, "npm run test is allowed"),
    bashRule("npm run build*", /\bnpm\s+run\s+build\b/i, "npm run build is allowed"),
    bashRule("tsc*", /(^|\s)tsc(\s|$)/i, "tsc is allowed"),
    bashRule("pytest*", /(^|\s)pytest(\s|$)/i, "pytest is allowed"),
    bashRule("uv run pytest*", /\buv\s+run\s+pytest\b/i, "uv run pytest is allowed"),
    bashRule("uv run python*", /\buv\s+run\s+python\b/i, "uv run python is allowed"),
    pathRule("Read(/workspace/**)", "file.read", "/workspace/", "workspace reads are allowed"),
    pathRule("Write(/workspace/**)", "file.write", "/workspace/", "workspace writes are allowed"),
    pathRule("Write(/workspace/**)", "file.edit", "/workspace/", "workspace edits are allowed"),
  ];
}

function blocksPlanTool(toolName: string): boolean {
  return (
    isExecutionToolName(toolName) ||
    toolName === "file.write" ||
    toolName === "file.edit"
  );
}

function normalizeCommand(command: string | undefined): string {
  return (command ?? "").trim();
}

function bashRule(pattern: string, regex: RegExp, reason: string): PolicyRule {
  return {
    action: pattern.includes("install") || pattern.includes("commit") || pattern.includes("push") ? "ask" : pattern.includes("test") || pattern.includes("build") || pattern.includes("python") || pattern.includes("pytest") || pattern.includes("tsc") ? "allow" : "deny",
    pattern: `Bash(${pattern})`,
    reason,
    matcher: (context) =>
      (
        isExecutionToolName(context.toolName)
      ) && regex.test(context.command),
  };
}

function pathRule(pattern: string, toolName: string, prefix: string, reason: string): PolicyRule {
  const normalizedPrefix = prefix.toLowerCase();
  return {
    action: pattern.startsWith("Write(") ? "allow" : pattern.startsWith("Read(") ? "allow" : "deny",
    pattern,
    reason,
    matcher: (context) =>
      context.toolName === toolName && context.command.toLowerCase().includes(normalizedPrefix),
  };
}

function toolRule(pattern: string, toolName: string, reason: string): PolicyRule {
  return {
    action: "deny",
    pattern,
    reason,
    matcher: (context) => context.toolName === toolName,
  };
}

function commandContainsRule(pattern: string, needle: string, reason: string): PolicyRule {
  const normalizedNeedle = needle.toLowerCase();
  return {
    action: "deny",
    pattern,
    reason,
    matcher: (context) => context.command.toLowerCase().includes(normalizedNeedle),
  };
}

function envFileRule(pattern: string, reason: string): PolicyRule {
  return {
    action: "deny",
    pattern,
    reason,
    matcher: (context) => /(^|[\s"'`])(\.env([.\w-]+)?)(?=$|[\s"'`])/i.test(context.command),
  };
}

function isExecutionToolName(toolName: string): boolean {
  return (
    toolName === "shell.run" ||
    toolName === "bash.run" ||
    toolName === "sandbox.exec" ||
    toolName === "run_test" ||
    toolName === "npm_test" ||
    toolName === "build"
  );
}
