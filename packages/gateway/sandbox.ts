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

  canWriteMemory(action: string): GatewaySandboxDecision {
    if (this.mode !== "read-only") {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `[guard] blocked ${action}: read-only mode forbids memory mutations.`,
    };
  }

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

  getToolSecurityProfile(tool: GatewayTool | undefined): ToolSecurityProfile {
    return resolveToolSecurityProfile({
      security: tool?.security,
      legacyPolicy: tool?.policy,
    });
  }

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

function isPathLikeKey(key: string): boolean {
  return /(path|file|dir|cwd|root|workspace)/i.test(key);
}

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
