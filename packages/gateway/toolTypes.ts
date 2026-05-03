import type {
  SandboxRequest,
  ToolSecurityProfile,
} from "../sandbox/src/types";

export type GatewayToolName = string;
export type GatewayToolInput = Record<string, unknown>;
export type GatewayToolAutomationLevel = "auto" | "confirm" | "manual";
export type GatewayToolRiskLevel =
  | "read-only"
  | "external-read"
  | "stateful"
  | "destructive";

export interface GatewayToolPolicy {
  automationLevel: GatewayToolAutomationLevel;
  riskLevel: GatewayToolRiskLevel;
  confirmationMessage?: string;
  tags?: string[];
}

export interface GatewayToolOutput {
  ok: boolean;
  content?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface GatewayToolContext {
  sessionId?: string;
  requestId?: string;
}

export interface GatewayToolSandboxSpec {
  resolve(
    input: GatewayToolInput,
    context?: GatewayToolContext
  ): Omit<SandboxRequest, "sessionId" | "toolName">;
}

export interface GatewayTool {
  name: GatewayToolName;
  description: string;
  inputSchema?: Record<string, unknown>;
  policy?: GatewayToolPolicy;
  security?: ToolSecurityProfile;
  sandboxSpec?: GatewayToolSandboxSpec;
  invoke(
    input: GatewayToolInput,
    context?: GatewayToolContext
  ): Promise<GatewayToolOutput>;
}

export interface GatewayToolListItem {
  name: GatewayToolName;
  description: string;
  inputSchema?: Record<string, unknown>;
  policy?: GatewayToolPolicy;
}
