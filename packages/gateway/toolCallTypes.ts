import type { ToolRegistry } from "./toolRegistry";
import type { GatewayToolOutput } from "./toolTypes";

export type GatewayToolCallStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

export type GatewayToolCallId = string;

export interface GatewayToolCallRequest {
  id: GatewayToolCallId;
  toolName: string;
  input: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
  createdAt: string;
}

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

export interface GatewayToolCallCreateInput {
  toolName: string;
  input?: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
}

export interface GatewayToolCallExecutorOptions {
  registry: ToolRegistry;
  auditLogger?: unknown;
}
