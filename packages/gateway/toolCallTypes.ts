
import type { GatewaySandbox } from "./sandbox";
import type {
  GatewayToolOutput,
  ToolCall,
  ToolResult,
  ToolRiskLevel,
} from "./toolTypes";
import type { ToolRegistry } from "./toolRegistry";
import type {
  GatewayPermissionDecision,
  GatewayPermissionMode,
  GatewayPlanState,
  GatewayToolPermissionLevel,
} from "./permissionTypes";

export type GatewayToolCallStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "denied";

export type GatewayToolCallId = string;

export interface GatewayProjectBoundary {
  projectDir: string | null;
  permission: "chat-only" | "project-write";
  allowedReadRoots: string[];
  allowedWriteRoots: string[];
  commandCwd: string | null;
}

export interface GatewayToolCallRequest extends ToolCall {
  toolName: string;
  input: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
  approved?: boolean;
  permissionMode?: GatewayPermissionMode;
  planState?: GatewayPlanState;
  createdAt: string;
  projectBoundary?: GatewayProjectBoundary;
  signal?: AbortSignal;
}

export interface GatewayToolCallRecord {
  id: GatewayToolCallId;
  toolName: string;
  input: Record<string, unknown>;
  status: GatewayToolCallStatus;
  riskLevel?: ToolRiskLevel;
  permissionLevel?: GatewayToolPermissionLevel;
  toolCall?: ToolCall;
  result?: ToolResult;
  output?: GatewayToolOutput;
  error?: string;
  sessionId?: string;
  requestId?: string;
  permissionMode?: GatewayPermissionMode;
  permissionDecision?: GatewayPermissionDecision;
  planState?: GatewayPlanState;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  audit?: {
    truncated?: boolean;
    artifactPath?: string;
    fileMutation?: Record<string, unknown>;
    execution?: Record<string, unknown>;
  };
}

export interface GatewayToolCallCreateInput {
  toolName: string;
  input?: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
  approved?: boolean;
  permissionMode?: GatewayPermissionMode;
  planState?: GatewayPlanState;
  projectBoundary?: GatewayProjectBoundary;
  signal?: AbortSignal;
}

export interface GatewayToolCallExecutorOptions {
  registry: ToolRegistry;
  auditLogger?: unknown;
  sandbox?: GatewaySandbox;
  projectRoot?: string;
  allowBypassPermissions?: boolean;
}
