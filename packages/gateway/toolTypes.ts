
import type { ToolSecurityProfile } from "./toolSecurityProfile";
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
  /** 方法 `execute`：负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。 */
  execute(args: unknown, context?: GatewayToolContext): Promise<ToolResult>;
}

export interface GatewayToolSandboxSpec {
  /** 方法 `resolve`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
  resolve(
    input: GatewayToolInput,
    context?: GatewayToolContext
  ): Record<string, unknown>;
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
  /** 方法 `execute`：负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。 */
  execute?(args: unknown, context?: GatewayToolContext): Promise<ToolResult>;
  inputSchema?: Record<string, unknown>;
  policy?: GatewayToolPolicy;
  security?: ToolSecurityProfile;
  sandboxSpec?: GatewayToolSandboxSpec;
  /** 方法 `invoke`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
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
