
import * as fs from "node:fs";
import * as path from "node:path";

import { SessionStore } from "./sessionStore";
import type {
  GatewaySession,
  GatewaySessionId,
  GatewayProjectScanResult,
  GatewayProjectConflictError,
  GatewayProjectBindingSource,
} from "./sessionTypes";
import type {
  GatewayPermissionMode,
  GatewayPlanState,
} from "./permissionTypes";
import type { GatewaySessionDevTaskState } from "./sessionTypes";
import { resolveWorkspacePath } from "../core/src/config";
import { readTranscript } from "../session/src/transcript";
import { SessionMemoryManager } from "./sessionMemoryManager";
import { isDangerousHostPath } from "./pathGuard";

const FORBIDDEN_PATH_SEGMENTS = [
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "$recycle.bin",
  "system volume information",
];

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
  constructor(
    private readonly sessionStore = new SessionStore(),
    private readonly workspaceDir?: string
  ) {
    const sessions = this.sessionStore.listSessions();

    if (sessions.length === 0) {
      const initialSession = this.sessionStore.createSession({
        name: "Default Session",
      });
      this.currentSessionId = initialSession.id;
      new SessionMemoryManager(initialSession.id, workspaceDir).init();
      return;
    }

    this.currentSessionId = sessions[0].id;
    new SessionMemoryManager(this.currentSessionId, workspaceDir).init();
  }

  /**
   * 方法 `createSession` 的职责说明。
   * `createSession` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  createSession(name?: string): GatewaySession {
    const session = this.sessionStore.createSession({ name });
    this.currentSessionId = session.id;
    new SessionMemoryManager(session.id, this.workspaceDir).init();
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

  deleteSession(sessionId: GatewaySessionId): boolean {
    const session = this.sessionStore.getSession(sessionId);
    if (!session) return false;

    const transcriptPath = session.transcriptPath;
    const sessionDir = resolveWorkspacePath("sessions", sessionId);

    this.sessionStore.deleteSession(sessionId);

    try {
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        fs.unlinkSync(transcriptPath);
      }
    } catch {
      /* transcript cleanup best-effort */
    }

    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch {
      /* session memory cleanup best-effort */
    }

    if (this.currentSessionId === sessionId) {
      const remaining = this.sessionStore.listSessions();
      this.currentSessionId = remaining.length > 0 ? remaining[0].id : "";
    }

    return true;
  }

  renameSession(sessionId: GatewaySessionId, name: string): GatewaySession {
    const renamed = this.sessionStore.renameSession({
      id: sessionId,
      name,
    });

    if (!renamed) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return renamed;
  }

  /**
   * 方法 `setCurrentSessionSkills` 的职责说明。
   * `setCurrentSessionSkills` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  setSessionSkills(sessionId: GatewaySessionId, skillNames: string[]): GatewaySession {
    const updated = this.sessionStore.setActiveSkills({
      id: sessionId,
      skillNames,
    });

    if (!updated) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return updated;
  }

  /**
   * 方法 `setCurrentSessionPermissionMode` 的职责说明。
   * `setCurrentSessionPermissionMode` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  /**
   * 方法 `setCurrentSessionPlanState` 的职责说明。
   * `setCurrentSessionPlanState` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  /**
   * 方法 `setCurrentSessionDevTaskState` 的职责说明。
   * `setCurrentSessionDevTaskState` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  setCurrentSessionDevTaskState(
    devTaskState: GatewaySessionDevTaskState | undefined
  ): GatewaySession {
    const updated = this.sessionStore.setDevTaskState(
      this.currentSessionId,
      devTaskState
    );

    if (!updated) {
      throw new Error("Current session not found.");
    }

    return updated;
  }

  /**
   * 方法 `addCurrentSessionApproval` 的职责说明。
   * `addCurrentSessionApproval` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  /**
   * 方法 `consumeCurrentSessionApproval` 的职责说明。
   * `consumeCurrentSessionApproval` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  consumeCurrentSessionApproval(token: string) {
    return this.sessionStore.consumePendingApproval(this.currentSessionId, token);
  }

  /**
   * 方法 `consumeSessionApproval` 的职责说明。
   * `consumeSessionApproval` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  consumeSessionApproval(sessionId: GatewaySessionId, token: string) {
    return this.sessionStore.consumePendingApproval(sessionId, token);
  }

  /**
   * 方法 `rejectCurrentSessionApproval` 的职责说明。
   * `rejectCurrentSessionApproval` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  rejectCurrentSessionApproval(token: string) {
    return this.sessionStore.rejectPendingApproval(this.currentSessionId, token);
  }

  /**
   * 方法 `rejectSessionApproval` 的职责说明。
   * `rejectSessionApproval` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  rejectSessionApproval(sessionId: GatewaySessionId, token: string) {
    return this.sessionStore.rejectPendingApproval(sessionId, token);
  }

  /**
   * 方法 `listCurrentSessionApprovals` 的职责说明。
   * `listCurrentSessionApprovals` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  listCurrentSessionApprovals() {
    return this.sessionStore.listPendingApprovals(this.currentSessionId);
  }

  /**
   * 方法 `listSessionApprovals` 的职责说明。
   * `listSessionApprovals` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  listSessionApprovals(sessionId: GatewaySessionId) {
    return this.sessionStore.listPendingApprovals(sessionId);
  }

  /**
   * 方法 `clearCurrentSessionApprovals` 的职责说明。
   * `clearCurrentSessionApprovals` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  incrementSessionMessageCount(
    sessionId: GatewaySessionId,
    count = 1
  ): GatewaySession {
    const updated = this.sessionStore.incrementMessageCount(sessionId, count);
    if (!updated) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return updated;
  }

  /**
   * 方法 `bindProjectDir` 的职责说明。
   * `bindProjectDir` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  bindProjectDir(
    sessionId: GatewaySessionId,
    rawProjectDir: string,
    allowedProjectRoots?: string[],
    bindingSource?: GatewayProjectBindingSource
  ): { session: GatewaySession; scan: GatewayProjectScanResult } {
    const session = this.sessionStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const resolvedProjectDir = this.validateProjectDir(rawProjectDir, allowedProjectRoots);

    if (session.projectBound && session.projectDir) {
      const existingNormalized = path.resolve(session.projectDir).toLowerCase().replace(/\//g, "\\");
      const requestedNormalized = resolvedProjectDir.toLowerCase().replace(/\//g, "\\");

      if (existingNormalized === requestedNormalized) {
        const currentSession = this.sessionStore.getSession(sessionId)!;
        const sessionDir = resolveWorkspacePath("sessions", sessionId);
        const scanPath = path.join(sessionDir, "project-scan.json");
        let scan: GatewayProjectScanResult;
        if (fs.existsSync(scanPath)) {
          scan = JSON.parse(fs.readFileSync(scanPath, "utf8"));
        } else {
          scan = this.scanProjectDir(resolvedProjectDir);
        }
        return { session: currentSession, scan };
      }

      const conflict: GatewayProjectConflictError = {
        code: "PROJECT_DIR_CONFLICT",
        message: `当前会话已经绑定 ${session.projectDir}，不能在同一会话中切换到 ${rawProjectDir}。请新开会话后再绑定该地址。`,
        existingProjectDir: session.projectDir,
        requestedProjectDir: rawProjectDir,
        suggestion: `:new ${rawProjectDir}`,
      };
      throw new Error(JSON.stringify(conflict));
    }

    const agentRebuildRoot = path.resolve("D:\\WorkStation\\agent-rebuild");
    const isSelfProject = resolvedProjectDir === agentRebuildRoot;
    const folderName = path.basename(resolvedProjectDir);
    const displayName = `[已绑定] ${folderName}`;

    this.sessionStore.setProjectBinding(sessionId, {
      projectDir: resolvedProjectDir,
      permission: "project-write",
      allowedReadRoots: [resolvedProjectDir],
      allowedWriteRoots: isSelfProject
        ? [
            path.join(resolvedProjectDir, "apps"),
            path.join(resolvedProjectDir, "packages"),
            path.join(resolvedProjectDir, "scripts"),
            path.join(resolvedProjectDir, "tests"),
            path.join(resolvedProjectDir, "package.json"),
            path.join(resolvedProjectDir, "tsconfig.json"),
            path.join(resolvedProjectDir, "README.md"),
          ]
        : [resolvedProjectDir],
      commandCwd: resolvedProjectDir,
      bindingSource: bindingSource ?? "repl",
      displayName,
    });

    const scan = this.scanProjectDir(resolvedProjectDir);

    const sessionDir = resolveWorkspacePath("sessions", sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    const scanPath = path.join(sessionDir, "project-scan.json");
    fs.writeFileSync(scanPath, JSON.stringify(scan, null, 2) + "\n", "utf8");

    const smm = new SessionMemoryManager(sessionId, this.workspaceDir);
    smm.setProjectDir(resolvedProjectDir);

    const updatedSession = this.sessionStore.getSession(sessionId)!;
    return { session: updatedSession, scan };
  }

  /**
   * 方法 `validateProjectDir` 的职责说明。
   * `validateProjectDir` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private validateProjectDir(
    rawPath: string,
    _allowedProjectRoots?: string[]
  ): string {
    const resolved = path.resolve(rawPath);
    const lowerPath = resolved.toLowerCase().replace(/\//g, "\\");

    for (const segment of FORBIDDEN_PATH_SEGMENTS) {
      if (lowerPath.includes(`\\${segment}\\`) || lowerPath.endsWith(`\\${segment}`)) {
        throw new Error(
          `Refused to bind system directory: ${resolved} (matched forbidden segment: ${segment})`
        );
      }
    }

    if (/^[a-z]:\\users$/i.test(lowerPath)) {
      throw new Error(`Refused to bind system directory: ${resolved}`);
    }

    if (isDangerousHostPath(resolved)) {
      throw new Error(`Refused to bind sensitive host directory: ${resolved}`);
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`Project directory does not exist: ${resolved}`);
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Project path is not a directory: ${resolved}`);
    }

    return resolved;
  }

  /**
   * 方法 `scanProjectDir` 的职责说明。
   * `scanProjectDir` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private scanProjectDir(projectDir: string): GatewayProjectScanResult {
    const scan: GatewayProjectScanResult = {
      projectDir,
      scannedAt: new Date().toISOString(),
      hasGit: false,
      hasPackageJson: false,
      hasPyprojectToml: false,
      hasPomXml: false,
      hasBuildGradle: false,
      hasOhPackageJson5: false,
      hasCmakeLists: false,
    };

    try {
      scan.hasGit = fs.existsSync(path.join(projectDir, ".git"));
    } catch { /* ignore */ }

    if (scan.hasGit) {
      try {
        const { execSync } = require("node:child_process");
        const branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: projectDir,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        scan.gitBranch = branch;
      } catch { /* ignore */ }

      try {
        const { execSync } = require("node:child_process");
        const status = execSync("git status --porcelain", {
          cwd: projectDir,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        scan.gitClean = status.length === 0;
      } catch { /* ignore */ }
    }

    const markerFiles: Array<[keyof GatewayProjectScanResult, string]> = [
      ["hasPackageJson", "package.json"],
      ["hasPyprojectToml", "pyproject.toml"],
      ["hasPomXml", "pom.xml"],
      ["hasBuildGradle", "build.gradle"],
      ["hasOhPackageJson5", "oh-package.json5"],
      ["hasCmakeLists", "CMakeLists.txt"],
    ];

    for (const [key, filename] of markerFiles) {
      try {
        (scan as unknown as Record<string, unknown>)[key] = fs.existsSync(
          path.join(projectDir, filename)
        );
      } catch { /* ignore */ }
    }

    if (scan.hasPackageJson) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
        if (pkg.scripts?.test) {
          scan.possibleTestCommand = "npm test";
        }
        if (pkg.scripts?.build) {
          scan.possibleBuildCommand = "npm run build";
        }
      } catch { /* ignore */ }
    }

    if (scan.hasPyprojectToml) {
      scan.possibleTestCommand = scan.possibleTestCommand ?? "pytest";
    }

    if (scan.hasPomXml) {
      scan.possibleTestCommand = scan.possibleTestCommand ?? "mvn test";
      scan.possibleBuildCommand = scan.possibleBuildCommand ?? "mvn package";
    }

    if (scan.hasBuildGradle) {
      scan.possibleTestCommand = scan.possibleTestCommand ?? "gradle test";
      scan.possibleBuildCommand = scan.possibleBuildCommand ?? "gradle build";
    }

    return scan;
  }

  /**
   * 方法 `summarizeSession` 的职责说明。
   * `summarizeSession` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  summarizeSession(sessionId?: string): string | null {
    const targetId = sessionId ?? this.currentSessionId;
    const session = this.sessionStore.getSession(targetId);
    if (!session) {
      return null;
    }

    const entries = readTranscript(targetId);
    if (entries.length === 0) {
      return null;
    }

    const userEntries = entries.filter((e) => e.role === "user");
    const assistantEntries = entries.filter((e) => e.role === "assistant");

    const recentUserMessages = userEntries.slice(-10).map((e) => {
      const content = typeof e.content === "string" ? e.content : "";
      return content.length > 200 ? content.slice(0, 200) + "…" : content;
    });

    const recentAssistantMessages = assistantEntries.slice(-5).map((e) => {
      const content = typeof e.content === "string" ? e.content : "";
      return content.length > 200 ? content.slice(0, 200) + "…" : content;
    });

    const lines: string[] = [];
    lines.push(`## Session Summary: ${session.displayName ?? session.name}`);
    lines.push(`- sessionId: ${targetId}`);
    lines.push(`- projectDir: ${session.projectDir ?? "none"}`);
    lines.push(`- messageCount: ${session.messageCount}`);
    lines.push(`- createdAt: ${session.createdAt}`);
    lines.push("");

    if (recentUserMessages.length > 0) {
      lines.push("### Recent user requests:");
      for (const msg of recentUserMessages) {
        if (msg.trim()) {
          lines.push(`- ${msg.replace(/\n/g, " ").slice(0, 200)}`);
        }
      }
      lines.push("");
    }

    if (recentAssistantMessages.length > 0) {
      lines.push("### Recent assistant responses:");
      for (const msg of recentAssistantMessages) {
        if (msg.trim()) {
          lines.push(`- ${msg.replace(/\n/g, " ").slice(0, 200)}`);
        }
      }
      lines.push("");
    }

    if (session.devTaskState) {
      lines.push("### Dev task state:");
      lines.push(`- status: ${session.devTaskState.status}`);
      lines.push(`- fixRounds: ${session.devTaskState.fixRounds}`);
      if (session.devTaskState.lastFailureSummary) {
        lines.push(`- lastFailure: ${session.devTaskState.lastFailureSummary.slice(0, 200)}`);
      }
      lines.push("");
    }

    const summary = lines.join("\n");

    const today = new Date().toISOString().slice(0, 10);
    const memoryDir = resolveWorkspacePath("memory");
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    const memoryPath = path.join(memoryDir, `${today}.md`);

    const section = `\n\n---\n\n${summary}`;
    fs.appendFileSync(memoryPath, section, "utf8");

    return summary;
  }
}
