import type { ToolRegistry } from "./toolRegistry";
import type { GatewayToolOutput } from "./toolTypes";
import type { GatewaySandbox } from "./sandbox";

/**
 * 工具调用生命周期状态。
 */
export type GatewayToolCallStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

/**
 * 工具调用唯一标识类型。
 */
export type GatewayToolCallId = string;

/**
 * 进入执行器之前的标准工具调用请求。
 */
export interface GatewayToolCallRequest {
  id: GatewayToolCallId;
  toolName: string;
  input: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
  approved?: boolean;
  createdAt: string;
}

/**
 * 工具执行后的完整记录。
 */
export interface GatewayToolCallRecord {
  id: GatewayToolCallId;
  toolName: string;
  input: Record<string, unknown>;
  status: GatewayToolCallStatus;
  output?: GatewayToolOutput;
  error?: string;
  sessionId?: string;
  requestId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

/**
 * 创建工具调用请求时的输入结构。
 */
export interface GatewayToolCallCreateInput {
  toolName: string;
  input?: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
  approved?: boolean;
}

/**
 * 工具调用执行器的依赖项。
 */
export interface GatewayToolCallExecutorOptions {
  registry: ToolRegistry;
  auditLogger?: unknown;
  sandbox?: GatewaySandbox;
}
