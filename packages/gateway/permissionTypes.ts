/**
 * ?????CS336 ???
 * ???packages/gateway/permissionTypes.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

export type GatewayPermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "dontAsk"
  | "bypassPermissions";

export type GatewayToolPermissionLevel =
  | "read"
  | "write"
  | "execute"
  | "plan"
  | "advanced";

export type GatewayPlanApprovalMode =
  | "approve"
  | "revise"
  | "reject"
  | "execute_with_context"
  | "execute_fresh";

export type GatewayPlanStatus =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "rejected";

export interface GatewayPlanState {
  active: boolean;
  status: GatewayPlanStatus;
  planId?: string;
  planPath?: string;
  summary?: string;
  content?: string;
  createdAt?: string;
  updatedAt?: string;
  approvedAt?: string;
  approvalMode?: GatewayPlanApprovalMode;
  rejectionReason?: string;
}

export interface GatewayPermissionDecision {
  action: "allow" | "deny";
  reason: string;
  mode: GatewayPermissionMode;
  requiresSandbox: boolean;
  matchedRule?: string;
  auditMetadata?: Record<string, unknown>;
}
