import { SessionStore } from "./sessionStore";
import type { GatewaySession, GatewaySessionId } from "./sessionTypes";
import type {
  GatewayPermissionMode,
  GatewayPlanState,
} from "./permissionTypes";

/**
 * 会话管理器。
 *
 * `SessionStore` 负责持久化快照，
 * `SessionManager` 负责“当前活跃会话”的业务决策和操作封装。
 */
export class SessionManager {
  private currentSessionId: GatewaySessionId;

  /**
   * 初始化会话管理器，并确保启动后总有一个可用会话。
   *
   * 如果历史会话为空，则创建默认会话；
   * 如果历史会话存在，则把最近一条排在首位的会话设为当前会话。
   */
  constructor(private readonly sessionStore = new SessionStore()) {
    const sessions = this.sessionStore.listSessions();

    if (sessions.length === 0) {
      const initialSession = this.sessionStore.createSession({
        name: "Default Session",
      });
      this.currentSessionId = initialSession.id;
      return;
    }

    this.currentSessionId = sessions[0].id;
  }

  /**
   * 创建新会话，并把它切换为当前会话。
   */
  createSession(name?: string): GatewaySession {
    const session = this.sessionStore.createSession({ name });
    this.currentSessionId = session.id;
    return session;
  }

  /**
   * 列出所有已知会话。
   */
  listSessions(): GatewaySession[] {
    return this.sessionStore.listSessions();
  }

  /**
   * 获取当前活跃会话。
   *
   * 如果当前会话 ID 指向的会话已经丢失，则自动创建一个恢复会话兜底，
   * 避免上层逻辑拿到 `undefined` 后崩溃。
   */
  getCurrentSession(): GatewaySession {
    const session = this.sessionStore.getSession(this.currentSessionId);
    if (!session) {
      const fallback = this.sessionStore.createSession({
        name: "Recovered Session",
      });
      this.currentSessionId = fallback.id;
      return fallback;
    }
    return session;
  }

  /**
   * 切换到指定会话。
   *
   * 切换成功后会顺手刷新该会话的 `updatedAt`，
   * 让最近使用过的会话排在列表更前面。
   */
  switchSession(id: GatewaySessionId): GatewaySession | undefined {
    const session = this.sessionStore.getSession(id);
    if (!session) {
      return undefined;
    }
    this.currentSessionId = session.id;
    this.sessionStore.touchSession(session.id);
    return this.sessionStore.getSession(session.id);
  }

  /**
   * 重命名当前会话。
   */
  renameCurrentSession(name: string): GatewaySession {
    const renamed = this.sessionStore.renameSession({
      id: this.currentSessionId,
      name,
    });

    if (!renamed) {
      throw new Error("Current session not found.");
    }

    return renamed;
  }

  setCurrentSessionSkills(skillNames: string[]): GatewaySession {
    const updated = this.sessionStore.setActiveSkills({
      id: this.currentSessionId,
      skillNames,
    });

    if (!updated) {
      throw new Error("Current session not found.");
    }

    return updated;
  }

  setCurrentSessionPermissionMode(
    permissionMode: GatewayPermissionMode
  ): GatewaySession {
    const updated = this.sessionStore.setPermissionMode(
      this.currentSessionId,
      permissionMode
    );

    if (!updated) {
      throw new Error("Current session not found.");
    }

    return updated;
  }

  setCurrentSessionPlanState(
    planState: GatewayPlanState | undefined
  ): GatewaySession {
    const updated = this.sessionStore.setPlanState(
      this.currentSessionId,
      planState
    );

    if (!updated) {
      throw new Error("Current session not found.");
    }

    return updated;
  }

  addCurrentSessionApproval(approval: {
    token: string;
    toolName: string;
    input: Record<string, unknown>;
    createdAt: string;
    expiresAt: string;
    message: string;
  }): GatewaySession {
    const updated = this.sessionStore.addPendingApproval({
      id: this.currentSessionId,
      approval,
    });

    if (!updated) {
      throw new Error("Current session not found.");
    }

    return updated;
  }

  consumeCurrentSessionApproval(token: string) {
    return this.sessionStore.consumePendingApproval(this.currentSessionId, token);
  }

  rejectCurrentSessionApproval(token: string) {
    return this.sessionStore.rejectPendingApproval(this.currentSessionId, token);
  }

  listCurrentSessionApprovals() {
    return this.sessionStore.listPendingApprovals(this.currentSessionId);
  }

  clearCurrentSessionApprovals() {
    return this.sessionStore.clearPendingApprovals(this.currentSessionId);
  }

  /**
   * 获取当前会话 ID。
   */
  getCurrentSessionId(): GatewaySessionId {
    return this.currentSessionId;
  }

  /**
   * 刷新当前会话的最近使用时间。
   */
  touchCurrentSession(): GatewaySession {
    const touched = this.sessionStore.touchSession(this.currentSessionId);
    if (!touched) {
      throw new Error("Current session not found.");
    }
    return touched;
  }

  /**
   * 增加当前会话的消息计数。
   *
   * 这个计数常用于展示会话活跃度，也可以作为后续压缩策略的参考指标。
   */
  incrementCurrentSessionMessageCount(count = 1): GatewaySession {
    const updated = this.sessionStore.incrementMessageCount(
      this.currentSessionId,
      count
    );
    if (!updated) {
      throw new Error("Current session not found.");
    }
    return updated;
  }
}
