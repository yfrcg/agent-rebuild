import * as path from "node:path";

import type { GatewayTool } from "./toolTypes";
import type { GatewayMcpServerConfig } from "./mcpTypes";
import { SandboxManager } from "../sandbox/src/manager";
import {
  resolveToolSecurityProfile,
} from "../sandbox/src/policy";
import { loadSandboxConfig } from "../sandbox/src/config";
import type {
  SandboxConfig,
  ToolSecurityProfile,
} from "../sandbox/src/types";

export type GatewaySandboxMode = "off" | "workspace-write" | "read-only";

export interface GatewaySandboxDecision {
  allowed: boolean;
  reason?: string;
}

export interface GatewaySandboxOptions {
  mode?: GatewaySandboxMode;
  allowedRoots?: string[];
  containerConfig?: Partial<SandboxConfig>;
  manager?: SandboxManager;
}

export class GatewaySandbox {
  readonly mode: GatewaySandboxMode;
  readonly allowedRoots: string[];
  readonly containerConfig: SandboxConfig;
  readonly manager: SandboxManager;

  constructor(
    modeOrOptions: GatewaySandboxMode | GatewaySandboxOptions = "off",
    allowedRoots: string[] = []
  ) {
    if (typeof modeOrOptions === "string") {
      this.mode = modeOrOptions;
      this.allowedRoots = allowedRoots.map(normalizeRoot);
      this.containerConfig = loadSandboxConfig();
      this.manager = new SandboxManager({
        config: this.containerConfig,
      });
      return;
    }

    this.mode = modeOrOptions.mode ?? "off";
    this.allowedRoots = (modeOrOptions.allowedRoots ?? []).map(normalizeRoot);
    this.containerConfig = loadSandboxConfig(process.env, modeOrOptions.containerConfig);
    this.manager =
      modeOrOptions.manager ??
      new SandboxManager({
        config: this.containerConfig,
      });
  }

  canWriteMemory(action: string): GatewaySandboxDecision {
    if (this.mode !== "read-only") {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `[sandbox] blocked ${action}: read-only sandbox forbids memory mutations.`,
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
        reason: `[sandbox] blocked tool ${tool.name}: destructive tools require GATEWAY_SANDBOX_MODE=off.`,
      };
    }

    if (this.mode === "read-only" && riskLevel === "stateful") {
      return {
        allowed: false,
        reason: `[sandbox] blocked tool ${tool.name}: read-only sandbox forbids stateful tools.`,
      };
    }

    if (this.mode === "workspace-write" && riskLevel === "stateful") {
      return {
        allowed: false,
        reason: `[sandbox] blocked tool ${tool.name}: workspace-write sandbox only allows read-only and external-read tools.`,
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
      const normalized = normalizeCandidatePath(candidate);
      if (!normalized) {
        continue;
      }

      if (!this.allowedRoots.some((root) => normalized.startsWith(root))) {
        return {
          allowed: false,
          reason: `[sandbox] blocked path input: ${candidate} is outside allowed roots.`,
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
        reason: `[sandbox] blocked MCP server ${config.id}: sandboxed mode requires isolation.enabled=true and isolation.mode=restricted.`,
      };
    }

    const runtimeRoot = config.isolation.runtimeRoot;
    if (!runtimeRoot) {
      return {
        allowed: false,
        reason: `[sandbox] blocked MCP server ${config.id}: restricted isolation requires an explicit runtimeRoot.`,
      };
    }

    const runtimeDecision = this.canUseToolInputPaths({
      runtimeRoot,
    });
    if (!runtimeDecision.allowed) {
      return {
        allowed: false,
        reason: `[sandbox] blocked MCP server ${config.id}: runtimeRoot must stay within allowed sandbox roots.`,
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

function normalizeCandidatePath(candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.includes("..")) {
    return normalizeRoot(path.resolve(process.cwd(), trimmed));
  }

  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    return normalizeRoot(trimmed);
  }

  if (/^[a-z]+:\/\//i.test(trimmed)) {
    return undefined;
  }

  return normalizeRoot(path.resolve(process.cwd(), trimmed));
}

function normalizeRoot(root: string): string {
  return root.replace(/[\\/]+/g, "\\").replace(/[\\/]$/, "").toLowerCase();
}
