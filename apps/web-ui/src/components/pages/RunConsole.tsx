/**
 * ?????CS336 ???
 * ???apps/web-ui/src/components/pages/RunConsole.tsx
 * ???Web UI ?????
 * ????????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import { useState, useRef, useEffect } from "react";
import { useGateway } from "../../providers/GatewayProvider";
import { useRunStore, type RunPhase } from "../../stores/runStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { GatewayError } from "@ws-client/types";

const PHASE_LABELS: Record<RunPhase, string> = {
  idle: "Ready",
  starting: "Starting…",
  running: "Running…",
  streaming: "Streaming…",
  completed: "Completed",
  cancelling: "Cancelling…",
  cancelled: "Cancelled",
  failed: "Failed",
};

const PHASE_COLORS: Record<RunPhase, string> = {
  idle: "var(--color-muted)",
  starting: "var(--color-warning)",
  running: "var(--color-accent)",
  streaming: "var(--color-accent)",
  completed: "var(--color-success)",
  cancelling: "var(--color-warning)",
  cancelled: "var(--color-cancelled)",
  failed: "var(--color-error)",
};

export function RunConsole() {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<
    { role: "user" | "assistant"; text: string }[]
  >([]);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const client = useGateway();
  const connectionState = useConnectionStore((s) => s.state);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const phase = useRunStore((s) => s.phase);
  const runId = useRunStore((s) => s.runId);
  const deltaBuffer = useRunStore((s) => s.deltaBuffer);
  const finalText = useRunStore((s) => s.finalText);
  const runError = useRunStore((s) => s.error);
  const startRun = useRunStore((s) => s.startRun);

  const isRunning =
    phase === "starting" || phase === "running" || phase === "streaming";

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [deltaBuffer, finalText, messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !currentSessionId || sending || isRunning) return;

    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", text }]);
    setSending(true);

    try {
      const result = await client.chatSend(currentSessionId, text);
      const r = result as Record<string, unknown>;
      startRun(
        r.runId as string,
        r.sessionId as string,
        r.requestId as string
      );
    } catch (err) {
      if (err instanceof GatewayError) {
        setError(`[${err.code}] ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    } finally {
      setSending(false);
    }
  };

  const handleCancel = async () => {
    if (!runId) return;
    try {
      await client.chatCancel(runId);
    } catch {
      // cancel is best-effort
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const displayText =
    phase === "completed" ? finalText : deltaBuffer;
  const isReady = connectionState === "ready" && !!currentSessionId;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2">
            <polyline points="4 17 10 11 4 5"/>
            <line x1="12" y1="19" x2="20" y2="19"/>
          </svg>
          <span style={styles.headerTitle}>Console</span>
        </div>
        <div style={styles.headerRight}>
          <span style={{
            ...styles.phaseBadge,
            color: PHASE_COLORS[phase],
            background: `${PHASE_COLORS[phase]}12`,
          }}>
            {phase !== "idle" && (
              <span style={{
                ...styles.phaseDot,
                background: PHASE_COLORS[phase],
                animation: isRunning ? "pulse 1.5s ease-in-out infinite" : "none",
              }} />
            )}
            {PHASE_LABELS[phase]}
          </span>
        </div>
      </div>

      <div style={styles.output} ref={outputRef}>
        {messages.length === 0 && !isRunning && !displayText && (
          <div style={styles.welcome}>
            <div style={styles.welcomeIcon}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <span style={styles.welcomeTitle}>Start a conversation</span>
            <span style={styles.welcomeHint}>
              {isReady
                ? "Type a message below to start chatting with the agent"
                : "Select or create a session in the sidebar to begin"}
            </span>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{
            ...styles.message,
            animation: "slideUp 0.2s ease",
          }}>
            <div style={styles.messageAvatar}>
              {msg.role === "user" ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                  <path d="M2 17l10 5 10-5"/>
                  <path d="M2 12l10 5 10-5"/>
                </svg>
              )}
            </div>
            <div style={styles.messageContent}>
              <span
                style={{
                  ...styles.role,
                  color:
                    msg.role === "user"
                      ? "var(--color-accent)"
                      : "var(--color-success)",
                }}
              >
                {msg.role === "user" ? "You" : "Agent"}
              </span>
              <span style={styles.msgText}>{msg.text}</span>
            </div>
          </div>
        ))}

        {(isRunning || displayText) && (
          <div style={{
            ...styles.message,
            animation: "slideUp 0.2s ease",
          }}>
            <div style={styles.messageAvatar}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={PHASE_COLORS[phase]} strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <div style={styles.messageContent}>
              <span style={{ ...styles.role, color: PHASE_COLORS[phase] }}>
                Agent
              </span>
              <span style={styles.msgText}>
                {displayText || PHASE_LABELS[phase]}
                {isRunning && <span style={styles.cursor}>▊</span>}
              </span>
            </div>
          </div>
        )}

        {phase === "failed" && runError && (
          <div style={styles.errorBox}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
            {runError}
          </div>
        )}

        {error && (
          <div style={styles.errorBox}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
            {error}
          </div>
        )}
      </div>

      <div style={styles.inputArea}>
        <div style={styles.inputWrapper}>
          <textarea
            ref={inputRef}
            style={styles.textarea}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isReady
                ? "Type a message… (Enter to send, Shift+Enter for newline)"
                : "Select a session first…"
            }
            disabled={!isReady}
            rows={1}
          />
        </div>
        <div style={styles.inputActions}>
          <span style={styles.charCount}>
            {input.length > 0 && `${input.length} chars`}
          </span>
          {isRunning ? (
            <button style={styles.cancelBtn} onClick={handleCancel}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
              </svg>
              Cancel
            </button>
          ) : (
            <button
              style={{
                ...styles.sendBtn,
                opacity: isReady && input.trim() ? 1 : 0.4,
              }}
              onClick={handleSend}
              disabled={!isReady || !input.trim() || sending}
            >
              {sending ? (
                <span style={styles.spinner} />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="22" y1="2" x2="11" y2="13"/>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              )}
              {sending ? "Sending…" : "Send"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "var(--color-surface)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--color-border-light)",
    overflow: "hidden",
    boxShadow: "var(--shadow-sm)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 16px",
    borderBottom: "1px solid var(--color-border-light)",
    background: "var(--color-surface)",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--color-text)",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  phaseBadge: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 10px",
    borderRadius: "var(--radius-full)",
    fontSize: 11,
    fontWeight: 500,
  },
  phaseDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
  },
  output: {
    flex: 1,
    overflow: "auto",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  welcome: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 40,
    animation: "fadeIn 0.3s ease",
  },
  welcomeIcon: {
    width: 64,
    height: 64,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--color-accent-light)",
    borderRadius: "var(--radius-xl)",
  },
  welcomeTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--color-text)",
  },
  welcomeHint: {
    fontSize: 13,
    color: "var(--color-muted)",
    textAlign: "center",
    lineHeight: 1.5,
  },
  message: {
    display: "flex",
    gap: 10,
    fontSize: 14,
    lineHeight: 1.6,
  },
  messageAvatar: {
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--color-surface-secondary)",
    borderRadius: "var(--radius-md)",
    flexShrink: 0,
  },
  messageContent: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  role: {
    fontWeight: 600,
    fontSize: 12,
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  msgText: {
    color: "var(--color-text)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    lineHeight: 1.6,
  },
  cursor: {
    animation: "blink 1s step-end infinite",
    color: "var(--color-accent)",
  },
  errorBox: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    background: "var(--color-error-light)",
    border: "1px solid var(--color-error)",
    borderRadius: "var(--radius-md)",
    color: "var(--color-error)",
    fontSize: 13,
    animation: "fadeIn 0.2s ease",
  },
  inputArea: {
    borderTop: "1px solid var(--color-border-light)",
    padding: "12px 16px",
    background: "var(--color-surface-secondary)",
  },
  inputWrapper: {
    display: "flex",
    alignItems: "center",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-md)",
    padding: "2px 4px",
    transition: "border-color var(--transition-fast)",
  },
  textarea: {
    flex: 1,
    padding: "8px 10px",
    background: "none",
    border: "none",
    color: "var(--color-text)",
    fontSize: 14,
    fontFamily: "var(--font-sans)",
    resize: "none",
    outline: "none",
    lineHeight: 1.5,
  },
  inputActions: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
  },
  charCount: {
    fontSize: 11,
    color: "var(--color-muted)",
  },
  sendBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 16px",
    background: "var(--color-accent)",
    border: "none",
    borderRadius: "var(--radius-md)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    transition: "all var(--transition-fast)",
  },
  cancelBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 16px",
    background: "var(--color-error)",
    border: "none",
    borderRadius: "var(--radius-md)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
  },
  spinner: {
    width: 14,
    height: 14,
    border: "2px solid rgba(255,255,255,0.3)",
    borderTopColor: "#fff",
    borderRadius: "50%",
    animation: "spin 0.6s linear infinite",
  },
};
