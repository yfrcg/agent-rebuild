/**
 * ?????CS336 ???
 * ???packages/gateway/sessionStore.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import { randomBytes } from "node:crypto";

import { getDb } from "../storage/src/db";
import { resolveWorkspacePath } from "../core/src/config";

import type {
  GatewayPendingApproval,
  GatewayProjectBindingSource,
  GatewaySession,
  GatewaySessionApprovalConsumeResult,
  GatewaySessionApprovalCreateInput,
  GatewaySessionCreateInput,
  GatewaySessionDevTaskState,
  GatewaySessionId,
  GatewaySessionProjectPermission,
  GatewaySessionRenameInput,
  GatewaySessionSkillInput,
} from "./sessionTypes";
import type {
  GatewayPermissionMode,
  GatewayPlanState,
} from "./permissionTypes";

function nowIso(): string {
  return new Date().toISOString();
}

let ensuredDb: unknown = null;

function ensureTable(): void {
  const db = getDb();
  if (ensuredDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      transcript_path TEXT NOT NULL,
      active_skills_json TEXT NOT NULL DEFAULT '[]',
      pending_approvals_json TEXT NOT NULL DEFAULT '[]',
      permission_mode TEXT NOT NULL DEFAULT 'default',
      plan_state_json TEXT,
      dev_task_state_json TEXT,
      project_dir TEXT,
      permission TEXT NOT NULL DEFAULT 'chat-only',
      project_bound INTEGER NOT NULL DEFAULT 0,
      project_bound_at TEXT,
      project_binding_source TEXT,
      allowed_read_roots_json TEXT NOT NULL DEFAULT '[]',
      allowed_write_roots_json TEXT NOT NULL DEFAULT '[]',
      command_cwd TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
  `);
  ensuredDb = db;
}

function rowToSession(row: Record<string, unknown>): GatewaySession {
  return {
    id: row.id as string,
    name: row.name as string,
    displayName: (row.display_name as string) ?? undefined,
    title: (row.title as string) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    messageCount: (row.message_count as number) ?? 0,
    transcriptPath: row.transcript_path as string,
    activeSkills: safeParseJsonArray(row.active_skills_json as string),
    pendingApprovals: safeParseApprovals(row.pending_approvals_json as string),
    permissionMode: ((row.permission_mode as string) ?? "default") as GatewayPermissionMode,
    planState: row.plan_state_json ? JSON.parse(row.plan_state_json as string) as GatewayPlanState : undefined,
    devTaskState: row.dev_task_state_json ? JSON.parse(row.dev_task_state_json as string) as GatewaySessionDevTaskState : undefined,
    projectDir: (row.project_dir as string) ?? null,
    permission: (row.permission === "project-write" ? "project-write" : "chat-only") as GatewaySessionProjectPermission,
    projectBound: Boolean(row.project_bound),
    projectBoundAt: (row.project_bound_at as string) ?? undefined,
    projectBindingSource: (row.project_binding_source as string) as GatewayProjectBindingSource | undefined,
    allowedReadRoots: safeParseJsonArray(row.allowed_read_roots_json as string),
    allowedWriteRoots: safeParseJsonArray(row.allowed_write_roots_json as string),
    commandCwd: (row.command_cwd as string) ?? null,
  };
}

function safeParseJsonArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function safeParseApprovals(raw: string): GatewayPendingApproval[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is GatewayPendingApproval =>
        !!item &&
        typeof item === "object" &&
        typeof item.token === "string" &&
        typeof item.toolName === "string" &&
        !!item.input &&
        typeof item.input === "object" &&
        !Array.isArray(item.input) &&
        typeof item.createdAt === "string" &&
        typeof item.expiresAt === "string" &&
        typeof item.message === "string"
    );
  } catch {
    return [];
  }
}

function insertSession(session: GatewaySession): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (
      id, name, display_name, title, created_at, updated_at, message_count,
      transcript_path, active_skills_json, pending_approvals_json,
      permission_mode, plan_state_json, dev_task_state_json,
      project_dir, permission, project_bound, project_bound_at,
      project_binding_source, allowed_read_roots_json, allowed_write_roots_json, command_cwd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.name,
    session.displayName ?? null,
    session.title ?? null,
    session.createdAt,
    session.updatedAt,
    session.messageCount,
    session.transcriptPath,
    JSON.stringify(session.activeSkills ?? []),
    JSON.stringify(session.pendingApprovals ?? []),
    session.permissionMode ?? "default",
    session.planState ? JSON.stringify(session.planState) : null,
    session.devTaskState ? JSON.stringify(session.devTaskState) : null,
    session.projectDir ?? null,
    session.permission ?? "chat-only",
    session.projectBound ? 1 : 0,
    session.projectBoundAt ?? null,
    session.projectBindingSource ?? null,
    JSON.stringify(session.allowedReadRoots ?? []),
    JSON.stringify(session.allowedWriteRoots ?? []),
    session.commandCwd ?? null
  );
}

function updateSession(session: GatewaySession): void {
  const db = getDb();
  db.prepare(
    `UPDATE sessions SET
      name = ?, display_name = ?, title = ?, updated_at = ?, message_count = ?,
      active_skills_json = ?, pending_approvals_json = ?,
      permission_mode = ?, plan_state_json = ?, dev_task_state_json = ?,
      project_dir = ?, permission = ?, project_bound = ?, project_bound_at = ?,
      project_binding_source = ?, allowed_read_roots_json = ?, allowed_write_roots_json = ?, command_cwd = ?
    WHERE id = ?`
  ).run(
    session.name,
    session.displayName ?? null,
    session.title ?? null,
    session.updatedAt,
    session.messageCount,
    JSON.stringify(session.activeSkills ?? []),
    JSON.stringify(session.pendingApprovals ?? []),
    session.permissionMode ?? "default",
    session.planState ? JSON.stringify(session.planState) : null,
    session.devTaskState ? JSON.stringify(session.devTaskState) : null,
    session.projectDir ?? null,
    session.permission ?? "chat-only",
    session.projectBound ? 1 : 0,
    session.projectBoundAt ?? null,
    session.projectBindingSource ?? null,
    JSON.stringify(session.allowedReadRoots ?? []),
    JSON.stringify(session.allowedWriteRoots ?? []),
    session.commandCwd ?? null,
    session.id
  );
}

export interface SessionStoreOptions {
  defaultAllowedReadRoots?: string[];
  defaultAllowedWriteRoots?: string[];
  defaultPermission?: GatewaySessionProjectPermission;
}

export class SessionStore {
  private readonly defaultAllowedReadRoots: string[];
  private readonly defaultAllowedWriteRoots: string[];
  private readonly defaultPermission: GatewaySessionProjectPermission;

  constructor(optionsOrPath?: string | SessionStoreOptions) {
    if (typeof optionsOrPath === "string") {
      this.defaultAllowedReadRoots = [];
      this.defaultAllowedWriteRoots = [];
      this.defaultPermission = "chat-only";
    } else {
      this.defaultAllowedReadRoots = optionsOrPath?.defaultAllowedReadRoots ?? [];
      this.defaultAllowedWriteRoots = optionsOrPath?.defaultAllowedWriteRoots ?? [];
      this.defaultPermission = optionsOrPath?.defaultPermission ?? "chat-only";
    }
    ensureTable();
  }

  loadSessions(): GatewaySession[] {
    const db = getDb();
    const rows = db.prepare(
      `SELECT * FROM sessions ORDER BY updated_at DESC`
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.withFreshApprovals(rowToSession(row)));
  }

  saveSessions(sessions: GatewaySession[]): void {
    const db = getDb();
    const existing = db.prepare(`SELECT id FROM sessions`).all() as Array<{ id: string }>;
    const existingIds = new Set(existing.map((r) => r.id));
    const newIds = new Set(sessions.map((s) => s.id));

    const insertTx = db.transaction(() => {
      for (const session of sessions) {
        if (existingIds.has(session.id)) {
          updateSession(session);
        } else {
          insertSession(session);
        }
      }
      for (const id of existingIds) {
        if (!newIds.has(id)) {
          db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
        }
      }
    });
    insertTx();
  }

  createSession(input?: GatewaySessionCreateInput): GatewaySession {
    const db = getDb();
    const count = (db.prepare(`SELECT COUNT(*) as c FROM sessions`).get() as { c: number }).c;
    const timestamp = Date.now();
    const id = `session-${timestamp}-${randomBytes(6).toString("hex")}`;
    const createdAt = nowIso();
    const session: GatewaySession = {
      id,
      name: input?.name?.trim() || `Session ${count + 1}`,
      createdAt,
      updatedAt: createdAt,
      messageCount: 0,
      transcriptPath: resolveWorkspacePath("sessions", `${id}.jsonl`),
      activeSkills: [],
      pendingApprovals: [],
      permissionMode: "default",
      projectDir: null,
      permission: this.defaultPermission,
      projectBound: false,
      allowedReadRoots: [...this.defaultAllowedReadRoots],
      allowedWriteRoots: [...this.defaultAllowedWriteRoots],
      commandCwd: null,
    };

    insertSession(session);
    return session;
  }

  listSessions(): GatewaySession[] {
    return this.loadSessions();
  }

  getSession(id: GatewaySessionId): GatewaySession | undefined {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.withFreshApprovals(rowToSession(row)) : undefined;
  }

  renameSession(input: GatewaySessionRenameInput): GatewaySession | undefined {
    const session = this.getSession(input.id);
    if (!session) return undefined;

    const name = input.name.trim();
    session.name = name;
    session.displayName = name;
    session.updatedAt = nowIso();
    updateSession(session);
    return session;
  }

  setActiveSkills(input: GatewaySessionSkillInput): GatewaySession | undefined {
    const session = this.getSession(input.id);
    if (!session) return undefined;

    session.activeSkills = [...new Set(input.skillNames.map((name) => name.trim()).filter(Boolean))];
    session.updatedAt = nowIso();
    updateSession(session);
    return session;
  }

  setPermissionMode(
    id: GatewaySessionId,
    permissionMode: GatewayPermissionMode
  ): GatewaySession | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;

    session.permissionMode = permissionMode;
    session.updatedAt = nowIso();
    updateSession(session);
    return session;
  }

  setPlanState(
    id: GatewaySessionId,
    planState: GatewayPlanState | undefined
  ): GatewaySession | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;

    session.planState = planState;
    session.updatedAt = nowIso();
    updateSession(session);
    return session;
  }

  addPendingApproval(
    input: GatewaySessionApprovalCreateInput
  ): GatewaySession | undefined {
    const session = this.getSession(input.id);
    if (!session) return undefined;

    const approvals = this.pruneExpiredApprovals(session.pendingApprovals ?? []);
    session.pendingApprovals = [...approvals, input.approval];
    session.updatedAt = nowIso();
    updateSession(session);
    return session;
  }

  listPendingApprovals(id: GatewaySessionId): GatewayPendingApproval[] {
    const session = this.getSession(id);
    return this.pruneExpiredApprovals(session?.pendingApprovals ?? []);
  }

  consumePendingApproval(
    id: GatewaySessionId,
    token: string
  ): GatewaySessionApprovalConsumeResult {
    const session = this.getRawSession(id);
    if (!session) return { status: "missing" };

    const originalApprovals = session.pendingApprovals ?? [];
    const approvals = this.pruneExpiredApprovals(originalApprovals);
    const index = approvals.findIndex((item) => item.token === token);
    if (index === -1) {
      const expiredApproval = originalApprovals.find(
        (item) => item.token === token && this.isExpiredApproval(item)
      );

      session.pendingApprovals = approvals;
      session.updatedAt = nowIso();
      updateSession(session);

      if (expiredApproval) {
        return { status: "expired", approval: expiredApproval };
      }
      return { status: "missing" };
    }

    const [approval] = approvals.splice(index, 1);
    session.pendingApprovals = approvals;
    session.updatedAt = nowIso();
    updateSession(session);
    return { status: "consumed", approval };
  }

  rejectPendingApproval(
    id: GatewaySessionId,
    token: string
  ): GatewaySessionApprovalConsumeResult {
    return this.removePendingApproval(id, token, "rejected");
  }

  clearPendingApprovals(id: GatewaySessionId): GatewayPendingApproval[] {
    const session = this.getSession(id);
    if (!session) return [];

    const approvals = this.pruneExpiredApprovals(session.pendingApprovals ?? []);
    session.pendingApprovals = [];
    session.updatedAt = nowIso();
    updateSession(session);
    return approvals;
  }

  setDevTaskState(
    id: GatewaySessionId,
    devTaskState: GatewaySessionDevTaskState | undefined
  ): GatewaySession | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;

    session.devTaskState = devTaskState;
    session.updatedAt = nowIso();
    updateSession(session);
    return session;
  }

  setProjectBinding(
    id: GatewaySessionId,
    binding: {
      projectDir: string;
      permission: GatewaySessionProjectPermission;
      allowedReadRoots: string[];
      allowedWriteRoots: string[];
      commandCwd: string;
      bindingSource?: GatewayProjectBindingSource;
      displayName?: string;
    }
  ): GatewaySession | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;

    session.projectDir = binding.projectDir;
    session.permission = binding.permission;
    session.projectBound = true;
    session.projectBoundAt = nowIso();
    session.projectBindingSource = binding.bindingSource ?? "repl";
    session.allowedReadRoots = [...binding.allowedReadRoots];
    session.allowedWriteRoots = [...binding.allowedWriteRoots];
    session.commandCwd = binding.commandCwd;
    if (binding.displayName) {
      session.displayName = binding.displayName;
    }
    session.updatedAt = nowIso();
    updateSession(session);
    return session;
  }

  touchSession(id: GatewaySessionId): GatewaySession | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;

    session.updatedAt = nowIso();
    updateSession(session);
    return session;
  }

  incrementMessageCount(
    id: GatewaySessionId,
    count = 1
  ): GatewaySession | undefined {
    const session = this.getSession(id);
    if (!session) return undefined;

    const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
    session.messageCount += safeCount;
    session.updatedAt = nowIso();
    updateSession(session);
    return session;
  }

  deleteSession(id: GatewaySessionId): boolean {
    const db = getDb();
    const result = db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  deleteAll(): void {
    ensureTable();
    const db = getDb();
    db.prepare(`DELETE FROM sessions`).run();
  }

  private getRawSession(id: GatewaySessionId): GatewaySession | undefined {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : undefined;
  }

  private pruneExpiredApprovals(
    approvals: GatewayPendingApproval[]
  ): GatewayPendingApproval[] {
    return approvals.filter((approval) => !this.isExpiredApproval(approval));
  }

  private withFreshApprovals(session: GatewaySession): GatewaySession {
    return {
      ...session,
      pendingApprovals: this.pruneExpiredApprovals(session.pendingApprovals ?? []),
      permissionMode: session.permissionMode ?? "default",
      projectDir: session.projectDir ?? null,
      permission: session.permission ?? "chat-only",
      projectBound: session.projectBound ?? (typeof session.projectDir === "string" && session.projectDir !== null),
      projectBoundAt: session.projectBoundAt ?? undefined,
      projectBindingSource: session.projectBindingSource ?? undefined,
      allowedReadRoots: session.allowedReadRoots ?? [],
      allowedWriteRoots: session.allowedWriteRoots ?? [],
      commandCwd: session.commandCwd ?? null,
    };
  }

  private removePendingApproval(
    id: GatewaySessionId,
    token: string,
    successStatus: "consumed" | "rejected"
  ): GatewaySessionApprovalConsumeResult {
    const session = this.getRawSession(id);
    if (!session) return { status: "missing" };

    const originalApprovals = session.pendingApprovals ?? [];
    const approvals = this.pruneExpiredApprovals(originalApprovals);
    const index = approvals.findIndex((item) => item.token === token);
    if (index === -1) {
      const expiredApproval = originalApprovals.find(
        (item) => item.token === token && this.isExpiredApproval(item)
      );

      session.pendingApprovals = approvals;
      session.updatedAt = nowIso();
      updateSession(session);

      if (expiredApproval) {
        return { status: "expired", approval: expiredApproval };
      }
      return { status: "missing" };
    }

    const [approval] = approvals.splice(index, 1);
    session.pendingApprovals = approvals;
    session.updatedAt = nowIso();
    updateSession(session);
    return { status: successStatus, approval };
  }

  private isExpiredApproval(approval: GatewayPendingApproval): boolean {
    const expiresAtMs = Date.parse(approval.expiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
  }
}
