import { useEffect, useMemo, useRef, useState } from "react";
import { GatewayError } from "@ws-client/types";
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

type RuntimeInfo = {
  model?: string;
  modelProvider?: string;
  supportsStreaming?: boolean;
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

function ConsoleApp() {
  const [activePage, setActivePage] = useState<PageId>("chat");
  const [eventsOpen, setEventsOpen] = useState(false);
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);

  useEffect(() => {
    if (!currentSessionId && sessions[0]) setCurrentSession(sessions[0].id);
  }, [currentSessionId, sessions, setCurrentSession]);

  const content = {
    chat: <ChatPage goTo={setActivePage} />,
    overview: <OverviewPage goTo={setActivePage} />,
    resources: <ResourcesPage />,
    approvals: <ApprovalsPage />,
    memory: <MemoryPage />,
    audit: <AuditPage />,
  }[activePage];

  return (
    <div className="app-shell">
      <div className="app-body">
        <SessionSidebar activePage={activePage} onPageChange={setActivePage} />
        <main className="workspace">
          <section className="page-surface">{content}</section>
        </main>
        <EventInspector collapsed={!eventsOpen} onToggle={() => setEventsOpen((v) => !v)} />
      </div>
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
              {isRenaming ? (
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

function ChatPage({ goTo }: { goTo: (page: PageId) => void }) {
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
  const lastFinalRef = useRef("");
  const sawDeltaRef = useRef(false);
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  const current = sessions.find((session) => session.id === currentSessionId);
  const isRunning = phase === "starting" || phase === "running" || phase === "streaming";
  const ready = connectionState === "ready" && Boolean(currentSessionId);
  const liveText = isRunning ? cleanAgentText(deltaBuffer) : playbackActive ? playbackText : "";

  const runEvents = useMemo(() => {
    return events
      .filter((event) => event.sessionId === currentSessionId)
      .filter((event) => !runId || !event.runId || event.runId === runId)
      .slice(0, 80)
      .reverse();
  }, [events, currentSessionId, runId]);

  useEffect(() => {
    let cancelled = false;
    if (!currentSessionId) {
      setMessages([]);
      return;
    }
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
    streamEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, liveText, runEvents.length, phase]);

  const send = async () => {
    const text = input.trim();
    if (!text || !currentSessionId || !ready || isRunning) return;
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
      setError(errorMessage(err, "发送失败"));
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

  return (
    <div className="chat-layout">
      <section className="chat-main">
        <div className="chat-toolbar">
          <div>
            <span className="eyebrow">当前会话</span>
            <h1>{current ? displaySessionName(current) : "选择或创建会话"}</h1>
            <div className="chat-topline">
              <span>模型 {String(runtime?.model ?? runtime?.modelProvider ?? "未知")}</span>
              <span>{runtime?.supportsStreaming ? "原生流式" : "模拟流式"}</span>
              <span>工具循环 {runtime?.autoToolLoopEnabled ? "开启" : "关闭"}</span>
              <span>多 Agent {runtime?.autoReviewGraphEnabled ? "开启" : "关闭"}</span>
              <span>工作目录 {current?.projectDir ? shortPath(current.projectDir) : "未绑定"}</span>
            </div>
          </div>
          <div className="toolbar-meta">
            <StatusPill tone={isRunning ? "accent" : phase === "failed" ? "danger" : "neutral"}>{phaseLabels[phase]}</StatusPill>
          </div>
        </div>
        <div className="message-stream">
          {messages.length === 0 && !liveText && runEvents.length === 0 && (
            <EmptyState
              icon="message"
              title="开始一次任务"
              text={ready ? "输入任务后，这里会同步展示模型输出、运行过程和工具调用。" : "先确认 Gateway 已连接，并选择一个会话。"}
            />
          )}
          {messages.map((message, index) => (
            <MessageBubble key={`${message.role}-${index}`} role={message.role} text={message.text} />
          ))}
          {(isRunning || runEvents.length > 0) && (
            <ProcessTimeline
              events={runEvents}
              phase={phase}
              runtime={runtime}
              liveTextAvailable={Boolean(liveText)}
            />
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
            <span>{input.length > 0 ? `${input.length} 字` : "过程、工具调用和最终回答会在同一条时间线里出现"}</span>
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
              {expanded === key && <pre>{safeJson(event.payload)}</pre>}
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

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.runtimeStatus(), client.toolList()])
      .then(([status, toolList]) => {
        if (cancelled) return;
        setRuntime(status as RuntimeInfo);
        setTools(normalizeTools((toolList as Record<string, unknown>).tools as Array<Record<string, unknown>>));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const failedEvents = events.filter((event) => event.event.includes("failed"));

  return (
    <div className="single-column">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Overview</span>
          <h1>运行概览</h1>
        </div>
      </div>
      <div className="overview-grid">
        <MetricCard label="会话" value={sessions.length} hint="已持久化会话数" icon="message" />
        <MetricCard label="工具" value={tools.length || Number(runtime?.toolCount ?? 0)} hint="可调用工具总数" icon="wrench" />
        <MetricCard label="事件" value={events.length} hint="当前前端缓存事件" icon="pulse" />
        <MetricCard label="异常" value={failedEvents.length} hint="失败事件数量" icon="shield" tone={failedEvents.length ? "danger" : "success"} />
      </div>
      <section className="panel wide">
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">Runtime</span>
            <h2>模型与编排</h2>
          </div>
        </div>
        <div className="kv-grid">
          <KeyValue label="模型" value={String(runtime?.model ?? "未知")} />
          <KeyValue label="流式能力" value={runtime?.supportsStreaming ? "原生流式" : "模拟流式"} />
          <KeyValue label="工具循环" value={runtime?.autoToolLoopEnabled ? "开启" : "关闭"} />
          <KeyValue label="多 Agent" value={runtime?.autoReviewGraphEnabled ? "开启" : "关闭"} />
        </div>
      </section>
      <div className="button-row">
        <button className="primary icon-text" onClick={() => goTo("chat")}><Icon name="message" />打开聊天</button>
        <button className="secondary icon-text" onClick={() => goTo("resources")}><Icon name="layers" />管理资源</button>
      </div>
    </div>
  );
}

function ResourcesPage() {
  const client = useGateway();
  const [tab, setTab] = useState<"tools" | "skills" | "mcp">("tools");
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [mcp, setMcp] = useState<McpStatus[]>([]);
  const [error, setError] = useState("");

  const refresh = async () => {
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
      setError(errorMessage(err, "资源读取失败"));
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
          {tools.map((tool) => (
            <div className="tool-card" key={tool.name}>
              <strong>{tool.name}</strong>
              <p>{tool.description || "暂无描述"}</p>
              <span>{tool.riskLevel ?? tool.category ?? tool.source ?? "tool"}</span>
            </div>
          ))}
        </div>
      )}
      {tab === "skills" && (
        <div className="data-grid">
          {skills.map((skill) => (
            <div className="data-card" key={skill.name}>
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

function ApprovalsPage() {
  const client = useGateway();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const approvals = useApprovalStore((s) => s.approvals);
  const [processing, setProcessing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const act = async (approval: ApprovalEntry, action: "confirm" | "reject") => {
    if (!currentSessionId) return;
    setProcessing(`${approval.token}:${action}`);
    setError("");
    try {
      if (action === "confirm") {
        await client.approvalConfirm(currentSessionId, approval.token);
      } else {
        await client.approvalReject(currentSessionId, approval.token);
      }
    } catch (err) {
      setError(errorMessage(err, "审批操作失败"));
    } finally {
      setProcessing(null);
    }
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
              <button className="danger" disabled={Boolean(processing)} onClick={() => void act(approval, "reject")}>
                {processing === `${approval.token}:reject` ? "拒绝中" : "拒绝"}
              </button>
            </div>
          </div>
        ))}
        {approvals.length === 0 && <EmptyState icon="shield" title="暂无待审批项" text="需要人工确认的工具调用会出现在这里。" />}
      </div>
    </div>
  );
}

function MemoryPage() {
  const client = useGateway();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const [query, setQuery] = useState("");
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<"auto" | "daily" | "long_term">("auto");
  const [results, setResults] = useState<Array<Record<string, unknown>>>([]);
  const [message, setMessage] = useState("");

  const search = async () => {
    if (!query.trim()) return;
    try {
      const payload = await client.memorySearch(query.trim());
      setResults(((payload.results ?? []) as unknown[]) as Array<Record<string, unknown>>);
      setMessage("");
    } catch (err) {
      setMessage(errorMessage(err, "搜索失败"));
    }
  };

  const write = async () => {
    if (!currentSessionId || !content.trim()) return;
    try {
      const payload = await client.memoryWrite(currentSessionId, content.trim(), scope);
      setMessage(`已写入 ${payload.filePath ?? payload.scope}`);
      setContent("");
    } catch (err) {
      setMessage(errorMessage(err, "写入失败"));
    }
  };

  return (
    <div className="resource-grid">
      <section className="panel">
        <div className="panel-head compact"><div><span className="eyebrow">Search</span><h2>搜索记忆</h2></div></div>
        <div className="search-box large">
          <Icon name="search" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search()} placeholder="输入关键词" />
        </div>
        <button className="primary full" onClick={() => void search()} disabled={!query.trim()}>搜索</button>
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
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={9} placeholder="记录需要长期保留的背景、约束或偏好" />
        <div className="segmented stretch">
          {[
            ["auto", "自动"],
            ["daily", "日记"],
            ["long_term", "长期"],
          ].map(([id, label]) => (
            <button key={id} className={scope === id ? "active" : ""} onClick={() => setScope(id as typeof scope)}>{label}</button>
          ))}
        </div>
        <button className="primary full" onClick={() => void write()} disabled={!currentSessionId || !content.trim()}>保存记忆</button>
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

  const refresh = async () => {
    try {
      const payload = await client.auditTail({ limit, type: type || undefined });
      setEntries(normalizeAuditPayload(payload));
      setError("");
    } catch (err) {
      setError(errorMessage(err, "读取审计日志失败"));
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
        {entries.map((entry, index) => (
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
  const groups = useMemo(() => summarizeEvents(events), [events]);

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
        <div><span className="eyebrow">Live Events</span><strong>{events.length}</strong></div>
        <div className="button-row">
          <button className="icon-button" onClick={onToggle} title="收起事件流"><Icon name="x" /></button>
          <button className="icon-button" onClick={clearEvents} title="清空"><Icon name="trash" /></button>
        </div>
      </div>
      <div className="event-summary">
        {groups.map((group) => <span key={group.name}>{group.name} {group.count}</span>)}
      </div>
      <div className="event-list">
        {events.map((event) => {
          const key = `${event.seq}-${event.event}`;
          return (
            <button className="event-row" key={key} onClick={() => setExpanded(expanded === key ? null : key)}>
              <span className={`event-kind ${event.event.includes("failed") ? "danger" : event.event.includes("finished") || event.event.includes("completed") ? "success" : ""}`} />
              <span>
                <strong>{event.event}</strong>
                <small>#{event.seq} · {formatTime(event.createdAt)}</small>
              </span>
              {expanded === key && <pre>{safeJson(event.payload)}</pre>}
            </button>
          );
        })}
        {events.length === 0 && <EmptyState icon="pulse" title="事件流为空" text="运行任务后这里会显示实时生命周期。" />}
      </div>
    </aside>
  );
}

function MessageBubble({ role, text, active }: { role: MessageRole; text: string; active?: boolean }) {
  const displayText = role === "assistant" ? cleanAgentText(text) : text;
  return (
    <article className={`message-bubble ${role}`}>
      <div className="bubble-avatar"><Icon name={role === "user" ? "user" : "spark"} /></div>
      <div className="bubble-body">
        <strong>{role === "user" ? "你" : "Assistant"}</strong>
        <p>{displayText}{active && <span className="cursor">|</span>}</p>
      </div>
    </article>
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
  const unwrapped = unwrapFinalJson(raw).replace(/\uFFFD/g, "").trim();
  return unwrapped;
}

function unwrapFinalJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.type === "final" && typeof parsed.content === "string") return parsed.content;
  } catch {
    // Keep non-JSON model output unchanged.
  }
  return raw;
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

function shortPath(value: string) {
  const normalized = value.replace(/\//g, "\\");
  const parts = normalized.split("\\").filter(Boolean);
  if (parts.length <= 3) return value;
  return `${parts[0]}\\...\\${parts.slice(-2).join("\\")}`;
}

function previewInput(value: unknown) {
  if (value === undefined || value === null) return "无输入预览";
  const raw = typeof value === "string" ? value : safeJson(value);
  return raw.length > 90 ? `${raw.slice(0, 90)}...` : raw;
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
  | "check";

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
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export default App;
