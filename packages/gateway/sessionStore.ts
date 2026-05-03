import * as fs from "node:fs";
import * as path from "node:path";

import { resolveWorkspacePath } from "../core/src/config";

import type {
  GatewayPendingApproval,
  GatewaySessionApprovalConsumeResult,
  GatewaySessionApprovalCreateInput,
  GatewaySession,
  GatewaySessionCreateInput,
  GatewaySessionId,
  GatewaySessionRenameInput,
  GatewaySessionSkillInput,
  GatewaySessionStoreSnapshot,
} from "./sessionTypes";

/**
 * 默认的会话快照文件路径。
 *
 * 会话元数据放在 `logs/` 下，而具体消息内容放在 `workspace/sessions/`，
 * 这样“列表索引”和“详细 transcript”分工更清晰。
 */
const DEFAULT_SNAPSHOT_PATH = path.resolve(
  process.cwd(),
  "logs",
  "sessions",
  "sessions.json"
);

/**
 * 获取当前 ISO 时间字符串。
 *
 * 抽成函数的目的，是避免各处重复 new Date().toISOString()，
 * 也方便以后做时间注入或测试替换。
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 会话元数据存储层。
 *
 * 这个类只管理会话列表、名称、时间戳和消息数量等轻量信息，
 * 不负责真正的消息逐行写入，那部分由 transcript 模块单独处理。
 */
export class SessionStore {
  constructor(private readonly snapshotPath = DEFAULT_SNAPSHOT_PATH) {
    this.ensureSnapshotFile();
  }

  /**
   * 加载全部会话，并按最近更新时间倒序排列。
   *
   * 这样列表展示时最活跃的会话会自然排在最前面。
   */
  loadSessions(): GatewaySession[] {
    const snapshot = this.readSnapshot();
    return [...snapshot.sessions]
      .map((session) => this.withFreshApprovals(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * 覆盖保存整份会话列表快照。
   */
  saveSessions(sessions: GatewaySession[]): void {
    this.writeSnapshot({
      sessions,
    });
  }

  /**
   * 创建一个全新的会话记录。
   *
   * 这里会同时生成：
   * - 唯一会话 ID
   * - transcript 文件路径
   * - 初始时间戳和消息计数
   */
  createSession(input?: GatewaySessionCreateInput): GatewaySession {
    const sessions = this.loadSessions();
    const timestamp = Date.now();
    const id = `session-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = nowIso();
    const session: GatewaySession = {
      id,
      name: input?.name?.trim() || `Session ${sessions.length + 1}`,
      createdAt,
      updatedAt: createdAt,
      messageCount: 0,
      transcriptPath: resolveWorkspacePath("sessions", `${id}.jsonl`),
      activeSkills: [],
      pendingApprovals: [],
    };

    sessions.push(session);
    this.saveSessions(sessions);

    return session;
  }

  /**
   * 列出所有会话。
   */
  listSessions(): GatewaySession[] {
    return this.loadSessions();
  }

  /**
   * 按 ID 获取单个会话。
   */
  getSession(id: GatewaySessionId): GatewaySession | undefined {
    const session = this.readSnapshot().sessions.find((item) => item.id === id);
    return session ? this.withFreshApprovals(session) : undefined;
  }

  /**
   * 重命名指定会话，并刷新更新时间。
   */
  renameSession(input: GatewaySessionRenameInput): GatewaySession | undefined {
    const sessions = this.loadSessions();
    const target = sessions.find((session) => session.id === input.id);

    if (!target) {
      return undefined;
    }

    target.name = input.name.trim();
    target.updatedAt = nowIso();
    this.saveSessions(sessions);
    return target;
  }

  setActiveSkills(input: GatewaySessionSkillInput): GatewaySession | undefined {
    const sessions = this.loadSessions();
    const target = sessions.find((session) => session.id === input.id);

    if (!target) {
      return undefined;
    }

    target.activeSkills = [...new Set(input.skillNames.map((name) => name.trim()).filter(Boolean))];
    target.updatedAt = nowIso();
    this.saveSessions(sessions);
    return target;
  }

  addPendingApproval(
    input: GatewaySessionApprovalCreateInput
  ): GatewaySession | undefined {
    const sessions = this.loadSessions();
    const target = sessions.find((session) => session.id === input.id);

    if (!target) {
      return undefined;
    }

    const approvals = this.pruneExpiredApprovals(target.pendingApprovals ?? []);
    target.pendingApprovals = [...approvals, input.approval];
    target.updatedAt = nowIso();
    this.saveSessions(sessions);
    return target;
  }

  listPendingApprovals(id: GatewaySessionId): GatewayPendingApproval[] {
    const session = this.readSnapshot().sessions.find((item) => item.id === id);
    return this.pruneExpiredApprovals(session?.pendingApprovals ?? []);
  }

  consumePendingApproval(
    id: GatewaySessionId,
    token: string
  ): GatewaySessionApprovalConsumeResult {
    const sessions = this.readSnapshot().sessions;
    const target = sessions.find((session) => session.id === id);

    if (!target) {
      return { status: "missing" };
    }

    const approvals = this.pruneExpiredApprovals(target.pendingApprovals ?? []);
    const index = approvals.findIndex((item) => item.token === token);
    if (index === -1) {
      const expiredApproval = (target.pendingApprovals ?? []).find(
        (item) => item.token === token && this.isExpiredApproval(item)
      );

      target.pendingApprovals = approvals;
      target.updatedAt = nowIso();
      this.saveSessions(sessions);

      if (expiredApproval) {
        return {
          status: "expired",
          approval: expiredApproval,
        };
      }

      return { status: "missing" };
    }

    const [approval] = approvals.splice(index, 1);
    target.pendingApprovals = approvals;
    target.updatedAt = nowIso();
    this.saveSessions(sessions);
    return {
      status: "consumed",
      approval,
    };
  }

  rejectPendingApproval(
    id: GatewaySessionId,
    token: string
  ): GatewaySessionApprovalConsumeResult {
    return this.removePendingApproval(id, token, "rejected");
  }

  clearPendingApprovals(id: GatewaySessionId): GatewayPendingApproval[] {
    const sessions = this.readSnapshot().sessions;
    const target = sessions.find((session) => session.id === id);

    if (!target) {
      return [];
    }

    const approvals = this.pruneExpiredApprovals(target.pendingApprovals ?? []);
    target.pendingApprovals = [];
    target.updatedAt = nowIso();
    this.saveSessions(sessions);
    return approvals;
  }

  /**
   * 只刷新会话更新时间，不改其他字段。
   */
  touchSession(id: GatewaySessionId): GatewaySession | undefined {
    const sessions = this.loadSessions();
    const target = sessions.find((session) => session.id === id);

    if (!target) {
      return undefined;
    }

    target.updatedAt = nowIso();
    this.saveSessions(sessions);
    return target;
  }

  /**
   * 增加某个会话的消息数量。
   *
   * 这里会把负数和非数值安全收敛成 0，避免脏输入把统计改坏。
   */
  incrementMessageCount(
    id: GatewaySessionId,
    count = 1
  ): GatewaySession | undefined {
    const sessions = this.loadSessions();
    const target = sessions.find((session) => session.id === id);

    if (!target) {
      return undefined;
    }

    const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
    target.messageCount += safeCount;
    target.updatedAt = nowIso();
    this.saveSessions(sessions);
    return target;
  }

  /**
   * 确保快照文件和父目录存在。
   *
   * 这是持久化层的启动兜底逻辑，
   * 防止第一次运行时因为文件不存在导致后续读取失败。
   */
  private ensureSnapshotFile(): void {
    const dirPath = path.dirname(this.snapshotPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    if (!fs.existsSync(this.snapshotPath)) {
      this.writeSnapshot({ sessions: [] });
    }
  }

  /**
   * 读取会话快照文件。
   *
   * 若文件为空、损坏或结构不合法，则返回空列表，
   * 用宽容读取策略保护上层流程不中断。
   */
  private readSnapshot(): GatewaySessionStoreSnapshot {
    this.ensureSnapshotFile();
    const raw = fs.readFileSync(this.snapshotPath, "utf8").trim();

    if (!raw) {
      return { sessions: [] };
    }

    try {
      const parsed = JSON.parse(raw) as GatewaySessionStoreSnapshot;
      if (!Array.isArray(parsed.sessions)) {
        return { sessions: [] };
      }
      return {
        sessions: parsed.sessions.map((session) => ({
          ...session,
          activeSkills: Array.isArray(session.activeSkills)
            ? session.activeSkills.filter((name): name is string => typeof name === "string")
            : [],
          pendingApprovals: Array.isArray(session.pendingApprovals)
            ? session.pendingApprovals.filter(
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
              )
            : [],
        })),
      };
    } catch {
      return { sessions: [] };
    }
  }

  /**
   * 把会话快照写回磁盘。
   *
   * 使用带缩进的 JSON，便于人工排查与手动修复。
   */
  private writeSnapshot(snapshot: GatewaySessionStoreSnapshot): void {
    fs.writeFileSync(
      this.snapshotPath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8"
    );
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
    };
  }

  private removePendingApproval(
    id: GatewaySessionId,
    token: string,
    successStatus: "consumed" | "rejected"
  ): GatewaySessionApprovalConsumeResult {
    const sessions = this.readSnapshot().sessions;
    const target = sessions.find((session) => session.id === id);

    if (!target) {
      return { status: "missing" };
    }

    const originalApprovals = target.pendingApprovals ?? [];
    const approvals = this.pruneExpiredApprovals(originalApprovals);
    const index = approvals.findIndex((item) => item.token === token);
    if (index === -1) {
      const expiredApproval = originalApprovals.find(
        (item) => item.token === token && this.isExpiredApproval(item)
      );

      target.pendingApprovals = approvals;
      target.updatedAt = nowIso();
      this.saveSessions(sessions);

      if (expiredApproval) {
        return {
          status: "expired",
          approval: expiredApproval,
        };
      }

      return { status: "missing" };
    }

    const [approval] = approvals.splice(index, 1);
    target.pendingApprovals = approvals;
    target.updatedAt = nowIso();
    this.saveSessions(sessions);
    return {
      status: successStatus,
      approval,
    };
  }

  private isExpiredApproval(approval: GatewayPendingApproval): boolean {
    const expiresAtMs = Date.parse(approval.expiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
  }
}
