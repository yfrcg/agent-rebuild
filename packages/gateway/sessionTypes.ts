/**
 * 会话 ID 类型。
 */
export type GatewaySessionId = string;

/**
 * 单个会话的元数据结构。
 */
export interface GatewaySession {
  id: GatewaySessionId;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  transcriptPath: string;
  activeSkills?: string[];
  pendingApprovals?: GatewayPendingApproval[];
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

/**
 * 创建会话时的输入参数。
 */
export interface GatewaySessionCreateInput {
  name?: string;
}

/**
 * 重命名会话时的输入参数。
 */
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

/**
 * 持久化到磁盘的会话快照结构。
 */
export interface GatewaySessionStoreSnapshot {
  sessions: GatewaySession[];
}
