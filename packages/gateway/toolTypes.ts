import type {
  SandboxRequest,
  ToolSecurityProfile,
} from "../sandbox/src/types";
import type { GatewayToolPermissionLevel } from "./permissionTypes";

export type GatewayToolName = string;
export type GatewayToolInput = Record<string, unknown>;
export type GatewayToolAutomationLevel = "auto" | "confirm" | "manual";
export type GatewayToolRiskLevel =
  | "read-only"
  | "external-read"
  | "stateful"
  | "destructive";
export type ToolRiskLevel = "safe" | "medium" | "dangerous";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  toolCallId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

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

export interface GatewayToolMetadata {
  permissionLevel: GatewayToolPermissionLevel;
  readOnly: boolean;
  sideEffect: boolean;
  requiresSandbox: boolean;
  timeoutMs?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema?: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  execute(args: unknown, context?: GatewayToolContext): Promise<ToolResult>;
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
  schema?: Record<string, unknown>;
  riskLevel?: ToolRiskLevel;
  permissionLevel?: GatewayToolPermissionLevel;
  readOnly?: boolean;
  sideEffect?: boolean;
  requiresSandbox?: boolean;
  timeoutMs?: number;
  execute?(args: unknown, context?: GatewayToolContext): Promise<ToolResult>;
  inputSchema?: Record<string, unknown>;
  policy?: GatewayToolPolicy;
  security?: ToolSecurityProfile;
  sandboxSpec?: GatewayToolSandboxSpec;
  invoke?(
    input: GatewayToolInput,
    context?: GatewayToolContext
  ): Promise<GatewayToolOutput>;
}

export interface GatewayToolListItem {
  name: GatewayToolName;
  description: string;
  schema?: Record<string, unknown>;
  riskLevel?: ToolRiskLevel;
  inputSchema?: Record<string, unknown>;
  policy?: GatewayToolPolicy;
  permissionLevel?: GatewayToolPermissionLevel;
  readOnly?: boolean;
  sideEffect?: boolean;
  requiresSandbox?: boolean;
  timeoutMs?: number;
}
