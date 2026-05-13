/**
 * ?????CS336 ???
 * ???packages/gateway/sessionTypes.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import type {
  GatewayPermissionMode,
  GatewayPlanState,
} from "./permissionTypes";

export type GatewaySessionId = string;

export type GatewaySessionProjectPermission = "chat-only" | "project-write";

export type GatewayProjectBindingSource = "user-path" | "cli" | "repl" | "future-gui" | "ws";

export interface GatewayProjectConflictError {
  code: "PROJECT_DIR_CONFLICT";
  message: string;
  existingProjectDir: string;
  requestedProjectDir: string;
  suggestion: string;
}

export interface GatewaySession {
  id: GatewaySessionId;
  name: string;
  displayName?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  transcriptPath: string;
  activeSkills?: string[];
  pendingApprovals?: GatewayPendingApproval[];
  permissionMode?: GatewayPermissionMode;
  planState?: GatewayPlanState;
  devTaskState?: GatewaySessionDevTaskState;
  projectDir: string | null;
  permission: GatewaySessionProjectPermission;
  projectBound: boolean;
  projectBoundAt?: string;
  projectBindingSource?: GatewayProjectBindingSource;
  allowedReadRoots: string[];
  allowedWriteRoots: string[];
  commandCwd: string | null;
}

export interface GatewaySessionDevTaskState {
  isDevTask: boolean;
  startedAt: string;
  updatedAt: string;
  filesTouched: string[];
  commandsRun: number;
  testCommands: string[];
  lastFailureSummary?: string;
  finalSummary?: string;
  fixRounds: number;
  status: "running" | "passed" | "failed" | "stopped";
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

export interface GatewaySessionBindProjectInput {
  sessionId: GatewaySessionId;
  projectDir: string;
  bindingSource?: GatewayProjectBindingSource;
}

export interface GatewayProjectScanResult {
  projectDir: string;
  scannedAt: string;
  hasGit: boolean;
  gitBranch?: string;
  gitClean?: boolean;
  hasPackageJson: boolean;
  hasPyprojectToml: boolean;
  hasPomXml: boolean;
  hasBuildGradle: boolean;
  hasOhPackageJson5: boolean;
  hasCmakeLists: boolean;
  possibleTestCommand?: string;
  possibleBuildCommand?: string;
}

/**
 * 函数 `extractProjectBoundary` 的职责说明。
 * `extractProjectBoundary` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function extractProjectBoundary(
  session: GatewaySession
): {
  projectDir: string | null;
  permission: "chat-only" | "project-write";
  allowedReadRoots: string[];
  allowedWriteRoots: string[];
  commandCwd: string | null;
} {
  return {
    projectDir: session.projectDir ?? null,
    permission: session.permission ?? "chat-only",
    allowedReadRoots: session.allowedReadRoots ?? [],
    allowedWriteRoots: session.allowedWriteRoots ?? [],
    commandCwd: session.commandCwd ?? null,
  };
}
