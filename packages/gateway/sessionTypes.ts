import type {
  GatewayPermissionMode,
  GatewayPlanState,
} from "./permissionTypes";

export type GatewaySessionId = string;

export interface GatewaySession {
  id: GatewaySessionId;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  transcriptPath: string;
  activeSkills?: string[];
  pendingApprovals?: GatewayPendingApproval[];
  permissionMode?: GatewayPermissionMode;
  planState?: GatewayPlanState;
}

export interface GatewayPendingApproval {
  token: string;
  toolName: string;
  input: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  message: string;
}

export interface GatewaySessionApprovalConsumeResult {
  status: "consumed" | "rejected" | "expired" | "missing";
  approval?: GatewayPendingApproval;
}

export interface GatewaySessionCreateInput {
  name?: string;
}

export interface GatewaySessionRenameInput {
  id: GatewaySessionId;
  name: string;
}

export interface GatewaySessionSkillInput {
  id: GatewaySessionId;
  skillNames: string[];
}

export interface GatewaySessionApprovalCreateInput {
  id: GatewaySessionId;
  approval: GatewayPendingApproval;
}

export interface GatewaySessionStoreSnapshot {
  sessions: GatewaySession[];
}
