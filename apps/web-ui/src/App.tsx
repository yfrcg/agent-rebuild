/**
 * ?????CS336 ???
 * ???apps/web-ui/src/App.tsx
 * ???Web UI ??????
 * ???????????????? Gateway ??????
 * ???????????????????????????????????? README ????????????????
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GatewayError } from "@ws-client/types";
import { MarkdownRenderer } from "./components/MarkdownRenderer";
import { GatewayProvider, useGateway } from "./providers/GatewayProvider";
import { useApprovalStore, type ApprovalEntry } from "./stores/approvalStore";
import { useConnectionStore } from "./stores/connectionStore";
import { useEventStore, type EventEntry } from "./stores/eventStore";
import { useRunStore, type RunPhase } from "./stores/runStore";
import { useSessionStore, type SessionEntry } from "./stores/sessionStore";

export type PageId = "chat" | "overview" | "resources" | "approvals" | "memory" | "audit";
type MessageRole = "user" | "assistant";

type ChatMessage = {
  role: MessageRole;
  text: string;
};

type ToolCallActivityItem = {
  id: string;
  tool: string;
  status: "running" | "done" | "failed";
  detail?: string;
};

type RuntimeInfo = {
  model?: string;
  modelProvider?: string;
  supportsStreaming?: boolean;
  availableModels?: Array<{ id: string; label: string }>;
  autoToolLoopEnabled?: boolean;
  autoReviewGraphEnabled?: boolean;
  sandboxAllowedRoots?: string[];
  toolCount?: number;
  sessionCount?: number;
  currentSessionId?: string;
  [key: string]: unknown;
};

type ToolInfo = {
  name: string;
  description?: string;
  category?: string;
  riskLevel?: string;
  source?: string;
};

type SkillInfo = {
  name: string;
  title?: string;
  description?: string;
  platform?: string;
  source?: string;
  aliases?: string[];
  userInvocable?: boolean;
};

type McpStatus = {
  id?: string;
  name?: string;
  enabled?: boolean;
  connected?: boolean;
  phase?: string;
  toolCount?: number;
  command?: string;
  cwd?: string;
  error?: string;
};

const navItems: Array<{ id: PageId; label: string; icon: IconName }> = [
  { id: "chat", label: "聊天", icon: "message" },
  { id: "overview", label: "概览", icon: "dashboard" },
  { id: "resources", label: "资源", icon: "layers" },
  { id: "approvals", label: "审批", icon: "shield" },
  { id: "memory", label: "记忆", icon: "brain" },
  { id: "audit", label: "审计", icon: "file" },
];

const phaseLabels: Record<RunPhase, string> = {
  idle: "待命",
  starting: "启动中",
  running: "运行中",
  streaming: "流式输出",
  completed: "已完成",
  cancelling: "取消中",
  cancelled: "已取消",
  failed: "失败",
};

const connectionLabels: Record<string, string> = {
  ready: "已连接",
  connecting: "连接中",
  authenticating: "认证中",
  reconnecting: "重连中",
  disconnected: "未连接",
};

function App() {
  return (
    <GatewayProvider>
      <ConsoleApp />
    </GatewayProvider>
  );
}

type ToastItem = { id: number; message: string; tone: "success" | "error" | "warning" | "info" };

let toastIdCounter = 0;

function ConsoleApp() {
  const [activePage, setActivePage] = useState<PageId>("chat");
  const [eventsOpen, setEventsOpen] = useState(true);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [pageKey, setPageKey] = useState(0);
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);

  const addToast = (message: string, tone: ToastItem["tone"] = "info") => {
    const id = ++toastIdCounter;
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  };

  const removeToast = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const handlePageChange = (page: PageId) => {
    if (page !== activePage) {
      setActivePage(page);
      setPageKey((k) => k + 1);
    }
  };

  useEffect(() => {
    if (!currentSessionId && sessions[0]) setCurrentSession(sessions[0].id);
  }, [currentSessionId, sessions, setCurrentSession]);

  const content = {
    chat: <ChatPage goTo={handlePageChange} addToast={addToast} />,
    overview: <OverviewPage goTo={handlePageChange} />,
    resources: <ResourcesPage addToast={addToast} />,
    approvals: <ApprovalsPage addToast={addToast} />,
    memory: <MemoryPage addToast={addToast} />,
    audit: <AuditPage />,
  }[activePage];

  return (
    <div className="app-shell">
      <div className="app-body">
        <SessionSidebar activePage={activePage} onPageChange={handlePageChange} />
        <main className="workspace">
          <section className={`page-surface${activePage === "chat" ? " page-surface--chat" : ""}`} key={pageKey}>
            <div className="page-enter">{content}</div>
          </section>
        </main>
        <EventInspector collapsed={!eventsOpen} onToggle={() => setEventsOpen((v) => !v)} />
      </div>
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast ${toast.tone}`} onClick={() => removeToast(toast.id)}>
              <Icon name={toast.tone === "success" ? "check" : toast.tone === "error" ? "x" : toast.tone === "warning" ? "shield" : "pulse"} />
              <span>{toast.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TopBar({ eventsOpen, onToggleEvents }: { eventsOpen: boolean; onToggleEvents: () => void }) {
  const state = useConnectionStore((s) => s.state);
  const lastHeartbeat = useConnectionStore((s) => s.lastHeartbeat);
  const reconnectCount = useConnectionStore((s) => s.reconnectCount);
  const activeRunIds = useRunStore((s) => s.activeRunIds);
  const pendingApprovals = useApprovalStore((s) => s.approvals.length);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><Icon name="spark" /></div>
        <div>
          <strong>Agent Rebuild</strong>
          <span>本地智能体控制台</span>
        </div>
      </div>
      <div className="topbar-center">
        <StatusPill tone={state === "ready" ? "success" : "warning"}>
          <span className="live-dot" />
          {connectionLabels[state] ?? state}
        </StatusPill>
        {reconnectCount > 0 && <StatusPill tone="warning">重连 {reconnectCount}</StatusPill>}
        {activeRunIds.length > 0 && <StatusPill tone="accent">{activeRunIds.length} 个任务运行中</StatusPill>}
        {pendingApprovals > 0 && <StatusPill tone="warning">{pendingApprovals} 个待审批</StatusPill>}
      </div>
      <div className="topbar-actions">
        {lastHeartbeat && <span className="heartbeat">心跳 {formatTime(lastHeartbeat)}</span>}
        <button className={`icon-button ${eventsOpen ? "active" : ""}`} onClick={onToggleEvents} title="事件面板">
          <Icon name="pulse" />
        </button>
      </div>
    </header>
  );
}

function SessionSidebar({
  activePage,
  onPageChange,
}: {
  activePage: PageId;
  onPageChange: (page: PageId) => void;
}) {
  const client = useGateway();
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setSessions = useSessionStore((s) => s.setSessions);
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);
  const updateSession = useSessionStore((s) => s.updateSession);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [projectDir, setProjectDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const filtered = sessions.filter((session) =>
    displaySessionName(session).toLowerCase().includes(query.toLowerCase())
  );
  const bindingSession = sessions.find((session) => session.id === bindingId);

  const refreshSessions = async () => {
    const list = await client.sessionList();
    setSessions(normalizeSessions(list as Array<Record<string, unknown>>));
  };

  const createSession = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = (await client.sessionCreate(newName.trim() || "新的对话")) as Record<string, unknown>;
      const sid = String(created.id ?? created.sessionId ?? "");
      await refreshSessions();
      if (sid) setCurrentSession(sid);
      setNewName("");
    } catch (err) {
      setError(errorMessage(err, "创建会话失败"));
    } finally {
      setBusy(false);
    }
  };

  const openBind = (session: SessionEntry) => {
    setBindingId(session.id);
    setRenamingId(null);
    setProjectDir(session.projectDir ?? "");
    setError(null);
  };

  const startRename = (session: SessionEntry) => {
    setBindingId(null);
    setRenamingId(session.id);
    setRenameValue(displaySessionName(session));
    setError(null);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
  };

  const submitRename = async (sessionId: string) => {
    const name = renameValue.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const renamed = (await client.sessionRename(name, sessionId)) as Record<string, unknown>;
      updateSession(sessionId, {
        name: typeof renamed.name === "string" ? renamed.name : name,
        displayName: typeof renamed.displayName === "string" ? renamed.displayName : name,
        updatedAt: typeof renamed.updatedAt === "string" ? renamed.updatedAt : undefined,
      });
      cancelRename();
      void refreshSessions();
    } catch (err) {
      setError(errorMessage(err, "重命名会话失败"));
    } finally {
      setBusy(false);
    }
  };

  const bindProject = async () => {
    if (!bindingId || !projectDir.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await client.sessionBindProject(bindingId, projectDir.trim())) as Record<string, unknown>;
      const session = ((result.session ?? result) as Record<string, unknown>) ?? {};
      updateSession(bindingId, {
        projectBound: true,
        projectDir: String(session.projectDir ?? projectDir.trim()),
        permission: String(session.permission ?? "project-write"),
        displayName: typeof session.displayName === "string" ? session.displayName : undefined,
      });
      setBindingId(null);
      setProjectDir("");
      void refreshSessions();
    } catch (err) {
      setError(errorMessage(err, "绑定项目目录失败"));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (sessionId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.sessionDelete(sessionId);
      setSessions(sessions.filter((s) => s.id !== sessionId));
      if (currentSessionId === sessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        if (remaining.length > 0) setCurrentSession(remaining[0].id);
      }
      setDeleteConfirmId(null);
      void refreshSessions();
    } catch (err) {
      setError(errorMessage(err, "删除会话失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="session-rail">
      <div className="rail-brand">
        <div className="brand-mark"><Icon name="spark" /></div>
        <div>
          <strong>Agent Rebuild</strong>
          <span>本地智能体控制台</span>
        </div>
      </div>
      <nav className="rail-nav" aria-label="功能区">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`rail-nav-button ${activePage === item.id ? "active" : ""}`}
            onClick={() => onPageChange(item.id)}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="rail-header">
        <div>
          <span className="eyebrow">Recent</span>
          <strong>最近会话</strong>
        </div>
        <button className="icon-button" title="刷新会话" onClick={() => void refreshSessions()}>
          <Icon name="refresh" />
        </button>
      </div>
      <button className="new-chat-button" onClick={() => void createSession()} disabled={busy}>
          <Icon name="plus" />
          <span>新聊天</span>
      </button>
      <div className="search-box">
        <Icon name="search" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索会话" />
      </div>
      <input
        className="session-name-input"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void createSession()}
        placeholder="可选：新会话名称"
      />
      {error && <div className="inline-error">{error}</div>}
      <div className="session-list">
        {filtered.map((session) => {
          const isRenaming = renamingId === session.id;
          return (
            <div
              key={session.id}
              className={`session-item ${session.id === currentSessionId ? "active" : ""} ${isRenaming ? "editing" : ""}`}
            >
              <div
                className="session-select"
                role="button"
                tabIndex={0}
                onClick={() => setCurrentSession(session.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setCurrentSession(session.id);
                  }
                }}
              >
                <span className="session-avatar">{displaySessionName(session).slice(0, 1).toUpperCase()}</span>
                <span className="session-copy">
                  {isRenaming ? (
                    <input
                      className="session-rename-input"
                      value={renameValue}
                      autoFocus
                      onChange={(e) => setRenameValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void submitRename(session.id);
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                    />
                  ) : (
                    <strong>{displaySessionName(session)}</strong>
                  )}
                  <small>{session.messageCount} 条消息 · {formatTime(session.updatedAt)}</small>
                  <span className="session-tags">
                    <span className={session.projectBound ? "tag-ok" : ""}>{session.projectBound ? "已绑定项目" : "未绑定"}</span>
                    {session.projectDir && <span title={session.projectDir}>{shortPath(session.projectDir)}</span>}
                  </span>
                </span>
              </div>
              {deleteConfirmId === session.id ? (
                <span className="session-actions">
                  <button
                    className="session-action"
                    title="确认删除"
                    onClick={() => void confirmDelete(session.id)}
                    disabled={busy}
                    style={{ color: "var(--danger)" }}
                  >
                    <Icon name="check" />
                  </button>
                  <button className="session-action" title="取消删除" onClick={() => setDeleteConfirmId(null)} disabled={busy}>
                    <Icon name="x" />
                  </button>
                </span>
              ) : isRenaming ? (
                <span className="session-actions">
                  <button
                    className="session-action"
                    title="保存名称"
                    onClick={() => void submitRename(session.id)}
                    disabled={busy || !renameValue.trim()}
                  >
                    <Icon name="check" />
                  </button>
                  <button className="session-action" title="取消重命名" onClick={cancelRename} disabled={busy}>
                    <Icon name="x" />
                  </button>
                </span>
              ) : (
                <span className="session-actions">
                  <button className="session-action" title="重命名会话" onClick={() => startRename(session)}>
                    <Icon name="edit" />
                  </button>
                  <button className="session-action" title="绑定工作目录" onClick={() => openBind(session)}>
                    <Icon name="folder" />
                  </button>
                  <button className="session-action" title="删除会话" onClick={() => setDeleteConfirmId(session.id)}>
                    <Icon name="trash" />
                  </button>
                </span>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <EmptyState icon="message" title="没有匹配会话" text="换一个关键词，或新建一个会话。" />}
      </div>
      {bindingId && (
        <div className="drawer">
          <div className="drawer-title">
            <div>
              <strong>绑定工作目录</strong>
              <small>{bindingSession ? displaySessionName(bindingSession) : bindingId}</small>
            </div>
            <button className="icon-button" onClick={() => setBindingId(null)} title="关闭">
              <Icon name="x" />
            </button>
          </div>
          <label>
            任意本机目录
            <input
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              placeholder="例如 D:\WorkStation\my-app 或 C:\src\project"
            />
          </label>
          <p className="muted-line">绑定后，文件和命令工具会以该目录作为读写边界。</p>
          <button className="primary full" onClick={() => void bindProject()} disabled={busy || !projectDir.trim()}>
            确认绑定
          </button>
        </div>
      )}
    </aside>
  );
}

function ChatPage({ goTo, addToast }: { goTo: (page: PageId) => void; addToast: (msg: string, tone?: ToastItem["tone"]) => void }) {
  const client = useGateway();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const connectionState = useConnectionStore((s) => s.state);
  const phase = useRunStore((s) => s.phase);
  const runId = useRunStore((s) => s.runId);
  const deltaBuffer = useRunStore((s) => s.deltaBuffer);
  const finalText = useRunStore((s) => s.finalText);
  const runError = useRunStore((s) => s.error);
  const startRun = useRunStore((s) => s.startRun);
  const events = useEventStore((s) => s.events);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [playbackText, setPlaybackText] = useState("");
  const [playbackActive, setPlaybackActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [sessionUsage, setSessionUsage] = useState<{ totalTokens: number; totalCostCents: number; totalPromptTokens: number; totalCompletionTokens: number; requestCount: number } | null>(null);
  const lastFinalRef = useRef("");
  const sawDeltaRef = useRef(false);
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  const current = sessions.find((session) => session.id === currentSessionId);
  const isRunning = phase === "starting" || phase === "running" || phase === "streaming";
  const ready = connectionState === "ready" && Boolean(currentSessionId);
  const liveText = isRunning ? cleanAgentText(deltaBuffer) : playbackActive ? playbackText : "";

  useEffect(() => {
    let cancelled = false;
    if (!currentSessionId) {
      setMessages([]);
      return;
    }
    setTranscriptLoading(true);
    client.sessionGetTranscript(currentSessionId)
      .then((payload) => {
        if (cancelled) return;
        const rawMessages = Array.isArray((payload as Record<string, unknown>).messages)
          ? ((payload as Record<string, unknown>).messages as unknown[])
          : [];
        setMessages(normalizeTranscriptMessages(rawMessages));
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setTranscriptLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, currentSessionId]);

  useEffect(() => {
    if (connectionState !== "ready") return;
    let cancelled = false;
    client.runtimeStatus()
      .then((payload) => {
        if (!cancelled) setRuntime(payload as RuntimeInfo);
      })
      .catch(() => {
        if (!cancelled) setRuntime(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, connectionState]);

  useEffect(() => {
    if (!currentSessionId || connectionState !== "ready") return;
    let cancelled = false;
    client.sessionUsage(currentSessionId)
      .then((payload) => {
        if (!cancelled) {
          const summary = (payload as Record<string, unknown>).summary as { totalTokens: number; totalCostCents: number; totalPromptTokens: number; totalCompletionTokens: number; requestCount: number } | undefined;
          if (summary) setSessionUsage(summary);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [client, currentSessionId, connectionState, phase]);

  useEffect(() => {
    if (deltaBuffer.trim()) sawDeltaRef.current = true;
  }, [deltaBuffer]);

  useEffect(() => {
    if (phase !== "completed" || !finalText.trim()) return;
    const text = cleanAgentText(finalText);
    const finalKey = `${runId ?? "no-run"}:${text}`;
    if (!text || lastFinalRef.current === finalKey) return;
    lastFinalRef.current = finalKey;

    if (sawDeltaRef.current) {
      setMessages((prev) => appendAssistantIfMissing(prev, text));
      sawDeltaRef.current = false;
      return;
    }

    setPlaybackText("");
    setPlaybackActive(true);
    let index = 0;
    const step = Math.max(1, Math.ceil(text.length / 90));
    const timer = window.setInterval(() => {
      index = Math.min(text.length, index + step);
      setPlaybackText(text.slice(0, index));
      if (index >= text.length) {
        window.clearInterval(timer);
        setMessages((prev) => appendAssistantIfMissing(prev, text));
        setPlaybackText("");
        setPlaybackActive(false);
        sawDeltaRef.current = false;
      }
    }, 18);
    return () => window.clearInterval(timer);
  }, [phase, finalText, runId]);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, liveText, phase]);

  const send = async () => {
    const text = input.trim();
    if (!text || !currentSessionId || !ready || isRunning) return;
    if (!currentSessionId) {
      addToast("请先选择一个会话", "warning");
      return;
    }
    setInput("");
    setError(null);
    setPlaybackText("");
    setPlaybackActive(false);
    sawDeltaRef.current = false;
    setMessages((prev) => [...prev, { role: "user", text }]);
    try {
      const result = await client.chatSend(currentSessionId, text);
      startRun(result.runId, result.sessionId, result.requestId);
    } catch (err) {
      const msg = errorMessage(err, "发送失败");
      setError(msg);
      addToast(msg, "error");
    }
  };

  const cancel = async () => {
    if (!runId) return;
    try {
      await client.chatCancel(runId);
    } catch {
      // best effort
    }
  };

  const toggleConfig = async (key: "autoToolLoopEnabled" | "autoReviewGraphEnabled", value: boolean) => {
    try {
      const result = await client.runtimeUpdateConfig({ [key]: value });
      setRuntime((prev) => ({ ...prev, ...result }));
    } catch (err) {
      addToast(errorMessage(err, "切换失败"), "error");
    }
  };

  const changeModelProvider = async (model: string) => {
    try {
      const result = await client.runtimeUpdateConfig({
        model: model as "mock" | "tokenplan" | "minimax",
      });
      setRuntime((prev) => ({ ...prev, ...result }));
      addToast(`模型供应商已切换为 ${labelForModel(model, runtime?.availableModels)}`, "success");
    } catch (err) {
      addToast(errorMessage(err, "切换模型供应商失败"), "error");
    }
  };

  return (
    <div className="chat-layout">
      <section className="chat-main">
        <div className="chat-toolbar">
          <div>
            <span className="eyebrow">当前会话</span>
            <h1>{current ? displaySessionName(current) : "选择或创建会话"}</h1>
            <div className="chat-topline">
              <label className="topline-item provider-select">
                <span>模型</span>
                <select
                  value={String(runtime?.model ?? runtime?.modelProvider ?? "tokenplan")}
                  disabled={!runtime || isRunning}
                  onChange={(e) => changeModelProvider(e.target.value)}
                >
                  {providerOptions(runtime).map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <span className="topline-sep" />
              <span className="topline-item">{runtime?.supportsStreaming ? "原生流式" : "模拟流式"}</span>
              <span className="topline-sep" />
              <label className="topline-item topline-toggle">
                工具循环
                <input
                  type="checkbox"
                  checked={runtime?.autoToolLoopEnabled ?? true}
                  onChange={(e) => toggleConfig("autoToolLoopEnabled", e.target.checked)}
                />
                <span className="toggle-track" />
              </label>
              <span className="topline-sep" />
              <label className="topline-item topline-toggle">
                多 Agent
                <input
                  type="checkbox"
                  checked={runtime?.autoReviewGraphEnabled ?? false}
                  onChange={(e) => toggleConfig("autoReviewGraphEnabled", e.target.checked)}
                />
                <span className="toggle-track" />
              </label>
              <span className="topline-sep" />
              <span className="topline-item">工作目录 {current?.projectDir ? shortPath(current.projectDir) : "未绑定"}</span>
              {sessionUsage && sessionUsage.totalTokens > 0 && (
                <>
                  <span className="topline-sep" />
                  <span className="topline-item" title={`输入 ${sessionUsage.totalPromptTokens?.toLocaleString() ?? 0} / 输出 ${sessionUsage.totalCompletionTokens?.toLocaleString() ?? 0}`}>
                    Token {sessionUsage.totalTokens.toLocaleString()} · ${(sessionUsage.totalCostCents / 100).toFixed(2)}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="toolbar-meta">
            <StatusPill tone={isRunning ? "accent" : phase === "failed" ? "danger" : "neutral"}>{phaseLabels[phase]}</StatusPill>
          </div>
        </div>
        <div className="message-stream">
          {transcriptLoading && messages.length === 0 && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "34px minmax(0, 1fr)", gap: 10 }}>
                <div className="skeleton skeleton-avatar" />
                <div>
                  <div className="skeleton skeleton-text short" />
                  <div className="skeleton skeleton-text long" />
                  <div className="skeleton skeleton-text medium" />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 34px", gap: 10 }}>
                <div>
                  <div className="skeleton skeleton-text medium" />
                  <div className="skeleton skeleton-text short" />
                </div>
                <div className="skeleton skeleton-avatar" />
              </div>
            </>
          )}
          {messages.length === 0 && !liveText && !transcriptLoading && (
            <EmptyState
              icon="message"
              title="开始一次任务"
              text={ready ? "输入任务后，右侧事件面板会同步展示工具调用过程。" : "先确认 Gateway 已连接，并选择一个会话。"}
            />
          )}
          {messages.map((message, index) => (
            <MessageBubble key={`${message.role}-${index}`} role={message.role} text={message.text} />
          ))}
          {isRunning && !liveText && (
            <div className="message-bubble assistant">
              <div className="bubble-avatar">A</div>
              <div className="typing-indicator">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            </div>
          )}
          {liveText && <MessageBubble role="assistant" text={liveText} active={isRunning || playbackActive} />}
          {(error || runError) && <div className="inline-error">{error ?? runError}</div>}
          <div ref={streamEndRef} />
        </div>
        <div className="composer">
          <textarea
            value={input}
            disabled={!ready}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={ready ? "输入任务，Enter 发送，Shift+Enter 换行" : "请先连接 Gateway 并选择会话"}
          />
          <div className="composer-actions">
            <span>{input.length > 0 ? `${input.length} 字` : "Enter 发送，Shift+Enter 换行"}</span>
            <div className="button-row">
              <button className="secondary icon-text" onClick={() => goTo("resources")}>
                <Icon name="layers" />
                资源
              </button>
              {isRunning ? (
                <button className="danger icon-text" onClick={() => void cancel()}>
                  <Icon name="stop" />
                  停止
                </button>
              ) : (
                <button className="primary icon-text" onClick={() => void send()} disabled={!ready || !input.trim()}>
                  <Icon name="send" />
                  发送
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="session-status-bar">
          <span className="status-bar-item">
            <span className={`status-dot ${isRunning ? "running" : ready ? "ready" : "disconnected"}`} />
            {isRunning ? "运行中" : ready ? "就绪" : "未连接"}
          </span>
          {currentSessionId && (
            <span className="status-bar-item" title={currentSessionId}>
              会话: {currentSessionId.slice(0, 8)}...
            </span>
          )}
          {sessionUsage && (
            <>
              <span className="status-bar-item">
                Token: {sessionUsage.totalTokens.toLocaleString()}
              </span>
              <span className="status-bar-item">
                费用: ${(sessionUsage.totalCostCents / 100).toFixed(2)}
              </span>
              <span className="status-bar-item">
                请求: {sessionUsage.requestCount}
              </span>
            </>
          )}
          {events.length > 0 && (
            <span className="status-bar-item">
              事件: {events.length}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function ProcessTimeline({
  events,
  phase,
  runtime,
  liveTextAvailable,
}: {
  events: EventEntry[];
  phase: RunPhase;
  runtime: RuntimeInfo | null;
  liveTextAvailable: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const visibleEvents = events.filter((event) => event.event !== "chat.delta");
  const syntheticStreaming =
    (phase === "streaming" || liveTextAvailable) &&
    !visibleEvents.some((event) => event.event === "chat.completed");

  return (
    <section className="process-block">
      <div className="process-head">
        <span className="process-dot" />
        <div>
          <strong>运行过程</strong>
          <small>
            模型 {runtime?.model ?? runtime?.modelProvider ?? "未知"} · 多 Agent {runtime?.autoReviewGraphEnabled ? "开启" : "关闭"}
          </small>
        </div>
      </div>
      <div className="process-list">
        {visibleEvents.map((event) => {
          const key = `${event.seq}-${event.event}`;
          const summary = summarizeProcessEvent(event);
          return (
            <button className={`process-step ${summary.tone}`} key={key} onClick={() => setExpanded(expanded === key ? null : key)}>
              <span className="step-icon"><Icon name={summary.icon} /></span>
              <span className="step-copy">
                <strong>{summary.title}</strong>
                <small>{summary.detail} · {formatTime(event.createdAt)}</small>
              </span>
              <span className="step-state">{summary.state}</span>
              {expanded === key && <pre>{safeJson(formatEventPayloadForDisplay(event))}</pre>}
            </button>
          );
        })}
        {syntheticStreaming && (
          <div className="process-step active">
            <span className="step-icon"><Icon name="spark" /></span>
            <span className="step-copy">
              <strong>模型正在生成</strong>
              <small>{runtime?.supportsStreaming ? "正在接收原生流式增量" : "后端完成后前端会模拟逐字输出"}</small>
            </span>
            <span className="step-state">running</span>
          </div>
        )}
        {visibleEvents.length === 0 && !syntheticStreaming && (
          <div className="process-step active">
            <span className="step-icon"><Icon name="pulse" /></span>
            <span className="step-copy">
              <strong>等待运行事件</strong>
              <small>任务开始后会显示工具、模型和 Agent 状态</small>
            </span>
            <span className="step-state">idle</span>
          </div>
        )}
      </div>
    </section>
  );
}

function OverviewPage({ goTo }: { goTo: (page: PageId) => void }) {
  const client = useGateway();
  const sessions = useSessionStore((s) => s.sessions);
  const events = useEventStore((s) => s.events);
  const approvals = useApprovalStore((s) => s.approvals);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.runtimeStatus(), client.toolList()])
      .then(([status, toolList]) => {
        if (cancelled) return;
        setRuntime(status as RuntimeInfo);
        setTools(normalizeTools((toolList as Record<string, unknown>).tools as Array<Record<string, unknown>>));
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const failedEvents = events.filter((event) => event.event.includes("failed"));
  const metrics = (runtime?.metrics ?? null) as Record<string, unknown> | null;
  const totalTokens = Number(metrics?.totalTokens ?? 0);
  const totalCostCents = Number(metrics?.totalCostCents ?? 0);
  const totalPromptTokens = Number(metrics?.totalPromptTokens ?? 0);
  const totalCompletionTokens = Number(metrics?.totalCompletionTokens ?? 0);

  return (
    <div className="single-column">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Overview</span>
          <h1>运行概览</h1>
        </div>
      </div>
      <div className="overview-grid">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => <div className="skeleton skeleton-card" key={i} />)
        ) : (
          <>
            <MetricCard label="会话" value={sessions.length} hint="已持久化会话数" icon="message" />
            <MetricCard label="工具" value={tools.length || Number(runtime?.toolCount ?? 0)} hint="可调用工具总数" icon="wrench" />
            <MetricCard label="事件" value={events.length} hint="当前前端缓存事件" icon="pulse" />
            <MetricCard label="异常" value={failedEvents.length} hint="失败事件数量" icon="shield" tone={failedEvents.length ? "danger" : "success"} />
            <MetricCard label="Token 总量" value={totalTokens} hint={`输入 ${totalPromptTokens.toLocaleString()} / 输出 ${totalCompletionTokens.toLocaleString()}`} icon="pulse" tone={totalTokens > 0 ? "accent" : "success"} />
            <MetricCard label="预估费用" value={totalCostCents} hint={`$${(totalCostCents / 100).toFixed(2)} USD`} icon="shield" tone={totalCostCents > 100 ? "warning" : "success"} />
          </>
        )}
      </div>
      <section className="panel wide">
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">Runtime</span>
            <h2>模型与编排</h2>
          </div>
        </div>
        <div className="kv-grid">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => <div className="skeleton" style={{ height: 60 }} key={i} />)
          ) : (
            <>
              <KeyValue label="模型" value={String(runtime?.model ?? "未知")} />
              <KeyValue label="流式能力" value={runtime?.supportsStreaming ? "原生流式" : "模拟流式"} />
              <KeyValue label="工具循环" value={runtime?.autoToolLoopEnabled ? "开启" : "关闭"} />
              <KeyValue label="多 Agent" value={runtime?.autoReviewGraphEnabled ? "开启" : "关闭"} />
            </>
          )}
        </div>
      </section>
      <div className="button-row">
        <button className="primary icon-text" onClick={() => goTo("chat")}><Icon name="message" />打开聊天</button>
        <button className="secondary icon-text" onClick={() => goTo("resources")}><Icon name="layers" />管理资源</button>
      </div>
    </div>
  );
}

function ResourcesPage({ addToast }: { addToast: (msg: string, tone?: ToastItem["tone"]) => void }) {
  const client = useGateway();
  const [tab, setTab] = useState<"tools" | "skills" | "mcp">("tools");
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [mcp, setMcp] = useState<McpStatus[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const [toolPayload, skillPayload, mcpPayload] = await Promise.all([
        client.toolList(),
        client.skillsList(),
        client.mcpStatus(),
      ]);
      setTools(normalizeTools((toolPayload as Record<string, unknown>).tools as Array<Record<string, unknown>>));
      setSkills(normalizeSkills((skillPayload as Record<string, unknown>).skills as Array<Record<string, unknown>>));
      const statuses = ((mcpPayload as Record<string, unknown>).statuses ?? []) as Array<Record<string, unknown>>;
      setMcp(statuses.map((item) => item as McpStatus));
      setError("");
    } catch (err) {
      const msg = errorMessage(err, "资源读取失败");
      setError(msg);
      addToast(msg, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="single-column">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Resources</span>
          <h1>资源与工具</h1>
        </div>
        <button className="secondary icon-text" onClick={() => void refresh()}><Icon name="refresh" />刷新</button>
      </div>
      <div className="segmented">
        <button className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>工具 {tools.length}</button>
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>技能 {skills.length}</button>
        <button className={tab === "mcp" ? "active" : ""} onClick={() => setTab("mcp")}>MCP {mcp.length}</button>
      </div>
      {error && <div className="inline-error">{error}</div>}
      {tab === "tools" && (
        <div className="tool-grid">
          {loading
            ? Array.from({ length: 8 }).map((_, i) => <div className="skeleton skeleton-card" key={i} />)
            : tools.map((tool, i) => (
                 <div className={`tool-card animate-fade-in-up stagger-${Math.min(i % 5 + 1, 5)}`} key={tool.name}>
                  <strong>{tool.name}</strong>
                  <p>{tool.description || "暂无描述"}</p>
                  <span>{tool.riskLevel ?? tool.category ?? tool.source ?? "tool"}</span>
                </div>
              ))}
        </div>
      )}
      {tab === "skills" && (
        <div className="data-grid">
          {loading
            ? Array.from({ length: 6 }).map((_, i) => <div className="skeleton skeleton-card" key={i} />)
            : skills.map((skill, i) => (
                 <div className={`data-card animate-fade-in-up stagger-${Math.min(i % 5 + 1, 5)}`} key={skill.name}>
                  <strong>{skill.title ?? skill.name}</strong>
                  <p>{skill.description ?? "暂无描述"}</p>
                  <small>{skill.source ?? skill.platform ?? "skill"}</small>
                </div>
              ))}
        </div>
      )}
      {tab === "mcp" && <DataList rows={mcp as Array<Record<string, unknown>>} empty="暂无 MCP 状态。" />}
    </div>
  );
}

function ApprovalsPage({ addToast }: { addToast: (msg: string, tone?: ToastItem["tone"]) => void }) {
  const client = useGateway();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const approvals = useApprovalStore((s) => s.approvals);
  const [processing, setProcessing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmReject, setConfirmReject] = useState<ApprovalEntry | null>(null);

  const act = async (approval: ApprovalEntry, action: "confirm" | "reject") => {
    if (!currentSessionId) return;
    setProcessing(`${approval.token}:${action}`);
    setError("");
    try {
      if (action === "confirm") {
        await client.approvalConfirm(currentSessionId, approval.token);
        addToast(`已批准 ${approval.toolName}`, "success");
      } else {
        await client.approvalReject(currentSessionId, approval.token);
        addToast(`已拒绝 ${approval.toolName}`, "info");
      }
    } catch (err) {
      const msg = errorMessage(err, "审批操作失败");
      setError(msg);
      addToast(msg, "error");
    } finally {
      setProcessing(null);
      setConfirmReject(null);
    }
  };

  const handleReject = (approval: ApprovalEntry) => {
    setConfirmReject(approval);
  };

  return (
    <div className="single-column">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Approvals</span>
          <h1>审批中心</h1>
        </div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <div className="approval-list">
        {approvals.map((approval) => (
          <div className="approval-card" key={approval.token}>
            <div className="approval-head">
              <StatusPill tone="warning">{approval.toolName}</StatusPill>
              <small>{formatTime(approval.createdAt)}</small>
            </div>
            {approval.message && <p>{approval.message}</p>}
            <pre className="result-box">{safeJson(approval.input)}</pre>
            <div className="button-row">
              <button className="primary" disabled={Boolean(processing)} onClick={() => void act(approval, "confirm")}>
                {processing === `${approval.token}:confirm` ? "批准中" : "批准"}
              </button>
              <button className="danger" disabled={Boolean(processing)} onClick={() => handleReject(approval)}>
                {processing === `${approval.token}:reject` ? "拒绝中" : "拒绝"}
              </button>
            </div>
          </div>
        ))}
        {approvals.length === 0 && <EmptyState icon="shield" title="暂无待审批项" text="需要人工确认的工具调用会出现在这里。" />}
      </div>
      {confirmReject && (
        <div className="confirm-overlay" onClick={() => setConfirmReject(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <strong>确认拒绝</strong>
            <p>确定要拒绝 {confirmReject.toolName} 的调用吗？此操作不可撤销。</p>
            <div className="button-row">
              <button className="secondary" onClick={() => setConfirmReject(null)}>取消</button>
              <button className="danger" disabled={Boolean(processing)} onClick={() => void act(confirmReject, "reject")}>
                {processing ? "拒绝中..." : "确认拒绝"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MemoryPage({ addToast }: { addToast: (msg: string, tone?: ToastItem["tone"]) => void }) {
  const client = useGateway();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const [query, setQuery] = useState("");
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<"auto" | "daily" | "long_term">("auto");
  const [results, setResults] = useState<Array<Record<string, unknown>>>([]);
  const [message, setMessage] = useState("");
  const [searching, setSearching] = useState(false);
  const [writing, setWriting] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [contentError, setContentError] = useState("");

  const search = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setQueryError("请输入搜索关键词");
      return;
    }
    setQueryError("");
    setSearching(true);
    try {
      const payload = await client.memorySearch(trimmed);
      setResults(((payload.results ?? []) as unknown[]) as Array<Record<string, unknown>>);
      setMessage("");
      if (((payload.results ?? []) as unknown[]).length === 0) {
        addToast("未找到相关记忆", "info");
      }
    } catch (err) {
      const msg = errorMessage(err, "搜索失败");
      setMessage(msg);
      addToast(msg, "error");
    } finally {
      setSearching(false);
    }
  };

  const write = async () => {
    const trimmed = content.trim();
    if (!trimmed) {
      setContentError("请输入要保存的内容");
      return;
    }
    if (!currentSessionId) {
      addToast("请先选择一个会话", "warning");
      return;
    }
    setContentError("");
    setWriting(true);
    try {
      const payload = await client.memoryWrite(currentSessionId, trimmed, scope);
      setMessage(`已写入 ${payload.filePath ?? payload.scope}`);
      setContent("");
      addToast("记忆已保存", "success");
    } catch (err) {
      const msg = errorMessage(err, "写入失败");
      setMessage(msg);
      addToast(msg, "error");
    } finally {
      setWriting(false);
    }
  };

  return (
    <div className="resource-grid">
      <section className="panel">
        <div className="panel-head compact"><div><span className="eyebrow">Search</span><h2>搜索记忆</h2></div></div>
        <div className={`search-box large ${queryError ? "input-error" : ""}`}>
          <Icon name="search" />
          <input value={query} onChange={(e) => { setQuery(e.target.value); setQueryError(""); }} onKeyDown={(e) => e.key === "Enter" && void search()} placeholder="输入关键词" />
        </div>
        {queryError && <div className="input-hint error">{queryError}</div>}
        <button className="primary full" onClick={() => void search()} disabled={!query.trim() || searching}>
          {searching ? <><span className="loading-spinner small" /> 搜索中...</> : "搜索"}
        </button>
        <div className="memory-results">
          {results.map((result, index) => (
            <div className="memory-card" key={String(result.chunkId ?? result.id ?? index)}>
              <strong>{String(result.filePath ?? result.source ?? result.id ?? "memory")}</strong>
              <p>{String(result.content ?? result.text ?? "")}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head compact"><div><span className="eyebrow">Write</span><h2>写入记忆</h2></div></div>
        <textarea className={contentError ? "input-error" : ""} value={content} onChange={(e) => { setContent(e.target.value); setContentError(""); }} rows={9} placeholder="记录需要长期保留的背景、约束或偏好" />
        {contentError && <div className="input-hint error">{contentError}</div>}
        <div className="segmented stretch">
          {[
            ["auto", "自动"],
            ["daily", "日记"],
            ["long_term", "长期"],
          ].map(([id, label]) => (
            <button key={id} className={scope === id ? "active" : ""} onClick={() => setScope(id as typeof scope)}>{label}</button>
          ))}
        </div>
        <button className="primary full" onClick={() => void write()} disabled={!currentSessionId || !content.trim() || writing}>
          {writing ? <><span className="loading-spinner small" /> 保存中...</> : "保存记忆"}
        </button>
        {message && <div className={message.startsWith("已") ? "inline-success" : "inline-error"}>{message}</div>}
      </section>
    </div>
  );
}

function AuditPage() {
  const client = useGateway();
  const [entries, setEntries] = useState<Array<Record<string, unknown>>>([]);
  const [limit, setLimit] = useState(50);
  const [type, setType] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const payload = await client.auditTail({ limit, type: type || undefined });
      setEntries(normalizeAuditPayload(payload));
      setError("");
    } catch (err) {
      setError(errorMessage(err, "读取审计日志失败"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [limit, type]);

  return (
    <div className="single-column">
      <div className="page-heading">
        <div><span className="eyebrow">Audit Trail</span><h1>审计日志</h1></div>
        <div className="control-row">
          <input value={type} onChange={(e) => setType(e.target.value)} placeholder="按类型过滤" />
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n} 条</option>)}
          </select>
          <button className="secondary icon-text" onClick={() => void refresh()}><Icon name="refresh" />刷新</button>
        </div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <div className="audit-table">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 12px" }}>
              <div className="skeleton" style={{ width: 60, height: 22, borderRadius: 999 }} />
              <div className="skeleton skeleton-text long" style={{ flex: 1 }} />
              <div className="skeleton" style={{ width: 80, height: 14 }} />
            </div>
          ))
        ) : entries.map((entry, index) => (
          <div className="audit-row" key={index}>
            <button onClick={() => setExpanded(expanded === index ? null : index)}>
              <StatusPill tone="neutral">{String(entry.type ?? "unknown")}</StatusPill>
              <span>{String(entry.message ?? entry.sessionId ?? entry.runId ?? "系统事件")}</span>
              <small>{formatTime(String(entry.ts ?? entry.createdAt ?? ""))}</small>
            </button>
            {expanded === index && <pre className="result-box">{safeJson(entry)}</pre>}
          </div>
        ))}
        {entries.length === 0 && <EmptyState icon="file" title="没有审计记录" text="调整过滤条件或等待系统产生日志。" />}
      </div>
    </div>
  );
}

function EventInspector({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const events = useEventStore((s) => s.events);
  const clearEvents = useEventStore((s) => s.clearEvents);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("tool");
  const groups = useMemo(() => summarizeEvents(events), [events]);

  const filteredEvents = useMemo(() => {
    if (filter === "all") return events;
    if (filter === "tool") return events.filter((e) => e.event.startsWith("tool.") || e.event.startsWith("run."));
    if (filter === "chat") return events.filter((e) => e.event.startsWith("chat.") || e.event.startsWith("run."));
    return events;
  }, [events, filter]);

  if (collapsed) {
    return (
      <aside className="event-inspector collapsed">
        <button className="event-collapse-button" onClick={onToggle} title="展开事件流">
          <Icon name="pulse" />
        </button>
        <span className="event-count-rail">{events.length}</span>
      </aside>
    );
  }

  return (
    <aside className="event-inspector">
      <div className="inspector-head">
        <div><span className="eyebrow">Live Events</span><strong>{filteredEvents.length}</strong></div>
        <div className="button-row">
          <button className="icon-button" onClick={onToggle} title="收起事件流"><Icon name="x" /></button>
          <button className="icon-button" onClick={clearEvents} title="清空"><Icon name="trash" /></button>
        </div>
      </div>
      <div className="event-filter">
        {[
          ["tool", "工具"],
          ["chat", "对话"],
          ["all", "全部"],
        ].map(([id, label]) => (
          <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      <div className="event-summary">
        {groups.map((group) => <span key={group.name}>{group.name} {group.count}</span>)}
      </div>
      <div className="event-list">
        {filteredEvents.map((event) => {
          const key = `${event.seq}-${event.event}`;
          return (
            <button className="event-row" key={key} onClick={() => setExpanded(expanded === key ? null : key)}>
              <span className={`event-kind ${event.event.includes("failed") ? "danger" : event.event.includes("finished") || event.event.includes("completed") ? "success" : ""}`} />
              <span>
                <strong>{event.event}</strong>
                <small>#{event.seq} · {formatTime(event.createdAt)}</small>
              </span>
              {expanded === key && <pre>{safeJson(formatEventPayloadForDisplay(event))}</pre>}
            </button>
          );
        })}
        {filteredEvents.length === 0 && <EmptyState icon="pulse" title="事件流为空" text="运行任务后这里会显示实时生命周期。" />}
      </div>
    </aside>
  );
}

function MessageBubble({ role, text, active }: { role: MessageRole; text: string; active?: boolean }) {
  const processed = role === "assistant" ? extractThinking(text) : { thinking: null, content: text };
  const [thinkOpen, setThinkOpen] = useState(false);
  const segments = role === "assistant" ? parseMessageSegments(processed.content) : null;
  const hasCards = segments?.some((s) => s.type === "tool_card") ?? false;
  return (
    <article className={`message-bubble ${role}`}>
      <div className="bubble-avatar"><Icon name={role === "user" ? "user" : "spark"} /></div>
      <div className="bubble-body">
        <strong>{role === "user" ? "你" : "Assistant"}</strong>
        {processed.thinking && (
          <div className="thinking-block">
            <button className="thinking-toggle" onClick={() => setThinkOpen(!thinkOpen)}>
              <Icon name={thinkOpen ? "chevron-up" : "chevron-down"} />
              <span>思考过程</span>
              <small>{thinkOpen ? "收起" : "展开"}</small>
            </button>
            {thinkOpen && <div className="thinking-content">{processed.thinking}</div>}
          </div>
        )}
        {hasCards ? (
          <div className="bubble-segments">
            {segments!.map((seg, i) => seg.type === "tool_card"
              ? <ToolCallCard key={i} tool={seg.tool} args={seg.args} />
              : seg.text.trim() ? <div key={i} className="bubble-markdown"><MarkdownRenderer content={seg.text} />{active && i === segments!.length - 1 && <span className="cursor">|</span>}</div> : null
            )}
          </div>
        ) : (
          <div className="bubble-markdown">
            <MarkdownRenderer content={processed.content} />
            {active && <span className="cursor">|</span>}
          </div>
        )}
      </div>
    </article>
  );
}

function ToolCallCard({ tool, args }: { tool: string; args: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const friendly: Record<string, { icon: IconName; label: string; desc: (a: Record<string, unknown>) => string }> = {
    "file.read": { icon: "file", label: "读取文件", desc: (a) => String(a.path ?? "") },
    "file.write": { icon: "file", label: "写入文件", desc: (a) => String(a.path ?? "") },
    "file.edit": { icon: "edit", label: "编辑文件", desc: (a) => String(a.path ?? "") },
    "file.list": { icon: "folder", label: "列出目录", desc: (a) => String(a.dir ?? a.path ?? ".") },
    "file.glob": { icon: "search", label: "搜索文件", desc: (a) => String(a.pattern ?? "") },
    "file.grep": { icon: "search", label: "搜索内容", desc: (a) => `${a.pattern ?? ""} in ${a.dir ?? "."}` },
    "shell.run": { icon: "wrench", label: "执行命令", desc: (a) => String(a.command ?? "") },
    "memory.search": { icon: "brain", label: "搜索记忆", desc: (a) => String(a.query ?? "") },
    "memory.write": { icon: "brain", label: "写入记忆", desc: (a) => String(a.content ?? "").slice(0, 60) },
    "web.search": { icon: "search", label: "网页搜索", desc: (a) => String(a.query ?? "") },
  };
  const info = friendly[tool] ?? { icon: "wrench" as IconName, label: tool, desc: () => JSON.stringify(args).slice(0, 80) };
  const hasDetails = Object.keys(args).length > 0;
  return (
    <div className={`tool-call-card ${expanded ? "expanded" : ""}`} onClick={() => hasDetails && setExpanded(!expanded)}>
      <span className="tool-call-card-icon"><Icon name={info.icon} /></span>
      <div className="tool-call-card-body">
        <strong>{info.label}</strong>
        <code>{info.desc(args)}</code>
      </div>
      {hasDetails && (
        <span className="tool-call-card-toggle">{expanded ? "▲" : "▼"}</span>
      )}
      {expanded && (
        <pre className="tool-call-card-details">{JSON.stringify(args, null, 2)}</pre>
      )}
    </div>
  );
}

function ToolCallActivity({ calls, running }: { calls: ToolCallActivityItem[]; running: boolean }) {
  const runningCount = calls.filter((call) => call.status === "running").length;
  const doneCount = calls.filter((call) => call.status === "done").length;
  const failedCount = calls.filter((call) => call.status === "failed").length;
  return (
    <section className="tool-activity" aria-label="工具调用状态">
      <div className="tool-activity-head">
        <span className="tool-activity-mark">
          {runningCount > 0 ? <span className="tool-call-spinner" /> : failedCount > 0 ? <Icon name="shield" /> : <Icon name="check" />}
        </span>
        <div>
          <strong>{runningCount > 0 ? "正在调用工具" : failedCount > 0 ? "工具调用出错" : "工具调用已完成"}</strong>
          <small>
            {runningCount > 0
              ? `${runningCount} 个工具运行中 · ${doneCount} 个已完成`
              : failedCount > 0
                ? `${failedCount} 个失败 · ${doneCount} 个成功`
                : `${calls.length} 个工具已返回`}
          </small>
        </div>
      </div>
      <div className="tool-activity-list">
        {calls.map((call) => (
          <div key={call.id} className={`tool-call-item ${call.status}`}>
            <span className="tool-call-icon"><Icon name={toolCallIcon(call.status)} /></span>
            <span className="tool-call-copy">
              <strong>{call.tool}</strong>
              {call.detail && <small>{call.detail}</small>}
            </span>
            <span className="tool-call-state">{toolCallStateLabel(call.status)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function RuntimeCard({ runtime }: { runtime: RuntimeInfo | null }) {
  return (
    <section className="side-card">
      <div className="side-card-head"><Icon name="dashboard" /><strong>运行配置</strong></div>
      <KeyValue label="模型" value={String(runtime?.model ?? runtime?.modelProvider ?? "未知")} />
      <KeyValue label="流式" value={runtime?.supportsStreaming ? "原生" : "模拟"} />
      <KeyValue label="工具循环" value={runtime?.autoToolLoopEnabled ? "开启" : "关闭"} />
      <KeyValue label="多 Agent" value={runtime?.autoReviewGraphEnabled ? "开启" : "关闭"} />
    </section>
  );
}

function SessionCard({ session }: { session?: SessionEntry }) {
  return (
    <section className="side-card">
      <div className="side-card-head"><Icon name="folder" /><strong>工作目录</strong></div>
      <p className="path-text">{session?.projectDir ?? "当前会话未绑定工作目录"}</p>
      <small>绑定后，读写和命令执行会限制在该目录内。</small>
    </section>
  );
}

function QuickActionCard({ icon, title, text, onClick }: { icon: IconName; title: string; text: string; onClick: () => void }) {
  return (
    <button className="quick-card" onClick={onClick}>
      <span><Icon name={icon} /></span>
      <strong>{title}</strong>
      <p>{text}</p>
    </button>
  );
}

function MetricCard({ label, value, hint, icon, tone = "accent" }: { label: string; value: number; hint: string; icon: IconName; tone?: string }) {
  return (
    <section className={`metric-card ${tone}`}>
      <span><Icon name={icon} /></span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <p>{hint}</p>
      </div>
    </section>
  );
}

function StatusPill({ children, tone }: { children: React.ReactNode; tone: "success" | "warning" | "danger" | "accent" | "neutral" }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function MetaChip({ label, value }: { label: string; value: string }) {
  return <span className="meta-chip"><small>{label}</small><strong>{value}</strong></span>;
}

function EmptyState({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className="empty-state">
      <span><Icon name={icon} /></span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="key-value">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function DataList({ rows, empty }: { rows: Array<Record<string, unknown>>; empty: string }) {
  if (rows.length === 0) return <EmptyState icon="layers" title="暂无数据" text={empty} />;
  return <div className="data-list">{rows.map((row, index) => <pre key={index}>{safeJson(row)}</pre>)}</div>;
}

function normalizeTranscriptMessages(messages: unknown[]): ChatMessage[] {
  return messages
    .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === "object" && !Array.isArray(message))
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as MessageRole,
      text: message.role === "assistant" ? cleanAgentText(String(message.content ?? "")) : String(message.content ?? ""),
    }))
    .filter((message) => message.text.trim().length > 0);
}

function appendAssistantIfMissing(messages: ChatMessage[], text: string): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.text === text) return messages;
  return [...messages, { role: "assistant", text }];
}

function normalizeAuditPayload(payload: unknown): Array<Record<string, unknown>> {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
  const rawEntries = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.events)
      ? record.events
      : Array.isArray(record?.entries)
        ? record.entries
        : [];
  return rawEntries.map((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : { value: entry }
  );
}

function cleanAgentText(raw: string): string {
  return unwrapFinalJson(raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/�/g, "").trim());
}

type MessageSegment =
  | { type: "text"; text: string }
  | { type: "tool_card"; tool: string; args: Record<string, unknown> };

function parseMessageSegments(raw: string): MessageSegment[] | null {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/\uFFFD/g, "").trim();
  if (!cleaned) return null;

  const segments: MessageSegment[] = [];
  const jsonRanges = extractStructuredJsonRanges(cleaned);
  let lastIndex = 0;
  let hasToolCard = false;

  for (const range of jsonRanges) {
    const before = cleaned.slice(lastIndex, range.start).trim();
    if (before) segments.push({ type: "text", text: before });

    const parsed = tryParseStructuredPayload(range.json);
    if (parsed?.type === "tool_call" && typeof parsed.tool === "string") {
      segments.push({
        type: "tool_card",
        tool: parsed.tool,
        args: (parsed.args ?? {}) as Record<string, unknown>,
      });
      hasToolCard = true;
    } else if (parsed?.type === "final" && typeof parsed.content === "string") {
      if (parsed.content.trim()) {
        segments.push({ type: "text", text: parsed.content });
      }
    } else {
      segments.push({ type: "text", text: range.json });
    }
    lastIndex = range.end;
  }

  const tail = cleaned.slice(lastIndex).trim();
  if (tail) segments.push({ type: "text", text: tail });

  if (!hasToolCard && segments.length === 1 && segments[0].type === "text") return null;
  return segments.length > 0 ? segments : null;
}

function extractThinking(raw: string): { thinking: string | null; content: string } {
  const cleaned = raw.replace(/\uFFFD/g, "").trim();
  const thinkMatch = cleaned.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    const thinking = thinkMatch[1].trim();
    const content = unwrapFinalJson(cleaned.replace(/<think>[\s\S]*?<\/think>/, "").trim());
    return { thinking: thinking || null, content: content || cleaned };
  }
  return { thinking: null, content: unwrapFinalJson(cleaned) };
}

function unwrapFinalJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.type === "final" && typeof parsed.content === "string") return parsed.content;
    if (parsed.type === "tool_call") return raw;
    const content = extractMeaningfulContent(parsed);
    if (content) return content;
  } catch {
    // Keep non-JSON model output unchanged.
  }
  return raw;
}

function extractMeaningfulContent(obj: Record<string, unknown>): string | undefined {
  const priorityKeys = ["content", "text", "message", "response", "answer", "result", "output"];
  for (const key of priorityKeys) {
    if (typeof obj[key] === "string" && obj[key].trim()) return obj[key].trim();
  }
  if (obj.data && typeof obj.data === "object" && obj.data !== null && !Array.isArray(obj.data)) {
    const nested = extractMeaningfulContent(obj.data as Record<string, unknown>);
    if (nested) return nested;
  }
  let longest = "";
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && value.length > longest.length && !value.startsWith("{")) {
      longest = value;
    }
  }
  return longest || undefined;
}

function extractStructuredJsonRanges(raw: string): Array<{ json: string; start: number; end: number }> {
  const results: Array<{ json: string; start: number; end: number }> = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\" && inString) {
      escapeNext = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push({ json: raw.slice(start, index + 1), start, end: index + 1 });
        start = -1;
      }
    }
  }

  return results;
}

function tryParseStructuredPayload(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizeSessions(list: Array<Record<string, unknown>>): SessionEntry[] {
  return list.map((session) => ({
    id: String(session.id ?? ""),
    name: String(session.name ?? "未命名会话"),
    messageCount: Number(session.messageCount ?? 0),
    updatedAt: String(session.updatedAt ?? ""),
    permission: session.permission as string | undefined,
    projectBound: Boolean(session.projectBound),
    projectDir: session.projectDir as string | null | undefined,
    displayName: session.displayName as string | undefined,
    activeSkills: Array.isArray(session.activeSkills)
      ? session.activeSkills.filter((name): name is string => typeof name === "string")
      : [],
  }));
}

function normalizeTools(list: Array<Record<string, unknown>> | undefined): ToolInfo[] {
  return (list ?? []).map((tool) => ({
    name: String(tool.name ?? ""),
    description: tool.description as string | undefined,
    category: tool.category as string | undefined,
    riskLevel: tool.riskLevel as string | undefined,
    source: tool.source as string | undefined,
  }));
}

function normalizeSkills(list: Array<Record<string, unknown>> | undefined): SkillInfo[] {
  return (list ?? []).map((skill) => ({
    name: String(skill.name ?? ""),
    title: skill.title as string | undefined,
    description: skill.description as string | undefined,
    platform: skill.platform as string | undefined,
    source: skill.source as string | undefined,
    aliases: Array.isArray(skill.aliases) ? skill.aliases.filter((item): item is string => typeof item === "string") : [],
    userInvocable: typeof skill.userInvocable === "boolean" ? skill.userInvocable : undefined,
  }));
}

function summarizeEvents(events: EventEntry[]) {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = event.event.split(".")[0] || "event";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).slice(0, 4).map(([name, count]) => ({ name, count }));
}

function summarizeProcessEvent(event: EventEntry): { title: string; detail: string; state: string; icon: IconName; tone: string } {
  const payload = asRecord(event.payload);
  if (event.event === "run.started") {
    return { title: "任务已启动", detail: `runId ${event.runId ?? payload.runId ?? "unknown"}`, state: "start", icon: "play", tone: "active" };
  }
  if (event.event === "run.progress") {
    return { title: String(payload.title ?? payload.message ?? "运行进度"), detail: String(payload.detail ?? payload.stage ?? "处理中"), state: String(payload.state ?? "running"), icon: "pulse", tone: "active" };
  }
  if (event.event === "tool.started") {
    return { title: `调用工具 ${payload.toolName ?? "unknown"}`, detail: previewInput(payload.inputPreview ?? payload.input), state: "running", icon: "wrench", tone: "active" };
  }
  if (event.event === "tool.finished") {
    return { title: `工具完成 ${payload.toolName ?? "unknown"}`, detail: formatDuration(payload.durationMs), state: "success", icon: "wrench", tone: "success" };
  }
  if (event.event === "tool.failed" || event.event === "tool.denied") {
    return { title: `工具失败 ${payload.toolName ?? "unknown"}`, detail: String(payload.error ?? payload.reason ?? "查看详情"), state: "failed", icon: "wrench", tone: "danger" };
  }
  if (event.event === "chat.completed") {
    const debug = asRecord(payload.debug);
    const autoToolLoop = asRecord(debug.autoToolLoop);
    const devTask = asRecord(debug.devTask);
    const toolCallCount = typeof autoToolLoop.toolCallCount === "number"
      ? autoToolLoop.toolCallCount
      : Array.isArray(payload.toolCalls)
        ? payload.toolCalls.length
        : 0;
    const detail = [
      `工具 ${toolCallCount}`,
      `开发任务 ${devTask.active ? "开启" : "关闭"}`,
    ].join(" · ");
    return { title: "最终回答已生成", detail, state: "done", icon: "spark", tone: "success" };
  }
  if (event.event === "run.finished") {
    return { title: "任务完成", detail: String(payload.status ?? "completed"), state: "done", icon: "check", tone: "success" };
  }
  if (event.event === "run.failed") {
    return { title: "任务失败", detail: String(payload.error ?? "查看详情"), state: "failed", icon: "shield", tone: "danger" };
  }
  if (event.event === "run.cancelled") {
    return { title: "任务已取消", detail: String(payload.status ?? "cancelled"), state: "cancelled", icon: "stop", tone: "neutral" };
  }
  return { title: event.event, detail: event.runId ?? "事件", state: "event", icon: "pulse", tone: "neutral" };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function displaySessionName(session: SessionEntry) {
  return session.displayName || session.name || session.id;
}

function formatTime(value?: string) {
  if (!value) return "无时间";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(value: unknown) {
  return typeof value === "number" ? `${value} ms` : "已返回结果";
}

function errorMessage(err: unknown, fallback: string) {
  if (err instanceof GatewayError) return `[${err.code}] ${err.message}`;
  if (err instanceof Error) return err.message;
  return fallback;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatEventPayloadForDisplay(event: EventEntry): unknown {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return event.payload;
  }

  const payload: Record<string, unknown> = { ...asRecord(event.payload) };

  if (event.event === "chat.completed" && typeof payload.text === "string") {
    payload.text = unwrapFinalJson(payload.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim());
  }

  if (event.event === "chat.delta") {
    if (typeof payload.text === "string") {
      payload.text = unwrapFinalJson(payload.text);
    }
    if (typeof payload.delta === "string") {
      payload.delta = unwrapFinalJson(payload.delta);
    }
  }

  return payload;
}

function shortPath(value: string) {
  const normalized = value.replace(/\//g, "\\");
  const parts = normalized.split("\\").filter(Boolean);
  if (parts.length <= 3) return value;
  return `${parts[0]}\\...\\${parts.slice(-2).join("\\")}`;
}

function providerOptions(runtime: RuntimeInfo | null): Array<{ id: string; label: string }> {
  const fromRuntime = runtime?.availableModels;
  if (Array.isArray(fromRuntime) && fromRuntime.length > 0) {
    return fromRuntime.filter((option) => option.id && option.label);
  }
  return [
    { id: "tokenplan", label: "MiniMax TokenPlan" },
    { id: "mock", label: "Mock" },
  ];
}

function labelForModel(
  model: string,
  options?: Array<{ id: string; label: string }>
): string {
  const option = options?.find((item) => item.id === model);
  if (option) return option.label;
  if (model === "tokenplan" || model === "minimax") return "MiniMax TokenPlan";
  if (model === "mock") return "Mock";
  return model;
}

function previewInput(value: unknown) {
  if (value === undefined || value === null) return "无输入预览";
  const raw = typeof value === "string" ? value : safeJson(value);
  return raw.length > 90 ? `${raw.slice(0, 90)}...` : raw;
}

function summarizeToolInput(value: unknown): string {
  if (value === undefined || value === null) {
    return "等待工具返回";
  }
  return previewInput(value);
}

function formatToolCompletion(durationMs: unknown): string {
  return typeof durationMs === "number"
    ? `完成，用时 ${formatDuration(durationMs)}`
    : "已返回结果";
}

function toolCallStateLabel(status: ToolCallActivityItem["status"]): string {
  if (status === "running") return "运行中";
  if (status === "done") return "完成";
  return "失败";
}

function toolCallIcon(status: ToolCallActivityItem["status"]): IconName {
  if (status === "done") return "check";
  if (status === "failed") return "x";
  return "wrench";
}

type IconName =
  | "message"
  | "dashboard"
  | "layers"
  | "shield"
  | "brain"
  | "file"
  | "spark"
  | "pulse"
  | "plus"
  | "search"
  | "folder"
  | "x"
  | "send"
  | "stop"
  | "wrench"
  | "refresh"
  | "play"
  | "trash"
  | "user"
  | "edit"
  | "check"
  | "chevron-up"
  | "chevron-down";

function Icon({ name }: { name: IconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<IconName, React.ReactNode> = {
    message: <path {...common} d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />,
    dashboard: <><rect {...common} x="3" y="3" width="7" height="7" /><rect {...common} x="14" y="3" width="7" height="7" /><rect {...common} x="14" y="14" width="7" height="7" /><rect {...common} x="3" y="14" width="7" height="7" /></>,
    layers: <><path {...common} d="m12 2 9 5-9 5-9-5z" /><path {...common} d="m3 12 9 5 9-5" /><path {...common} d="m3 17 9 5 9-5" /></>,
    shield: <path {...common} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    brain: <><path {...common} d="M8 6a4 4 0 0 1 8 0v1a4 4 0 0 1 0 8v1a4 4 0 0 1-8 0v-1a4 4 0 0 1 0-8z" /><path {...common} d="M12 4v16" /></>,
    file: <><path {...common} d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path {...common} d="M14 2v6h6" /></>,
    spark: <><path {...common} d="M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5z" /><path {...common} d="M19 3v4M21 5h-4" /></>,
    pulse: <path {...common} d="M3 12h4l3-8 4 16 3-8h4" />,
    plus: <><path {...common} d="M12 5v14" /><path {...common} d="M5 12h14" /></>,
    search: <><circle {...common} cx="11" cy="11" r="8" /><path {...common} d="m21 21-4.3-4.3" /></>,
    folder: <path {...common} d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
    x: <><path {...common} d="M18 6 6 18" /><path {...common} d="m6 6 12 12" /></>,
    send: <><path {...common} d="m22 2-7 20-4-9-9-4z" /><path {...common} d="M22 2 11 13" /></>,
    stop: <rect {...common} x="5" y="5" width="14" height="14" rx="2" />,
    wrench: <path {...common} d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0L21 6.1A6 6 0 0 1 12.8 14l-6.3 6.3a2.1 2.1 0 0 1-3-3L9.8 11A6 6 0 0 1 17.9 3z" />,
    refresh: <><path {...common} d="M21 12a9 9 0 0 1-15.5 6.3L3 16" /><path {...common} d="M3 16v5h5" /><path {...common} d="M3 12A9 9 0 0 1 18.5 5.7L21 8" /><path {...common} d="M21 3v5h-5" /></>,
    play: <path {...common} d="m8 5 11 7-11 7z" />,
    trash: <><path {...common} d="M3 6h18" /><path {...common} d="M8 6V4h8v2" /><path {...common} d="M19 6l-1 14H6L5 6" /></>,
    user: <><circle {...common} cx="12" cy="8" r="4" /><path {...common} d="M4 21a8 8 0 0 1 16 0" /></>,
    edit: <><path {...common} d="M12 20h9" /><path {...common} d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
    check: <path {...common} d="M20 6 9 17l-5-5" />,
    "chevron-up": <path {...common} d="m18 15-6-6-6 6" />,
    "chevron-down": <path {...common} d="m6 9 6 6 6-6" />,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export default App;
