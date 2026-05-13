/**
 * ?????CS336 ???
 * ???apps/web-ui/src/components/pages/ToolTimeline.tsx
 * ???Web UI ?????
 * ????????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import { useMemo, useState } from "react";
import { useEventStore, type EventEntry } from "../../stores/eventStore";

type ToolEventKind = "started" | "finished" | "failed" | "denied";

const TOOL_EVENT_KINDS = ["started", "finished", "failed", "denied"];

const KIND_COLORS: Record<ToolEventKind, string> = {
  started: "var(--color-warning)",
  finished: "var(--color-success)",
  failed: "var(--color-error)",
  denied: "var(--color-cancelled)",
};

const KIND_ICONS: Record<ToolEventKind, string> = {
  started: "▶",
  finished: "✓",
  failed: "✗",
  denied: "⊘",
};

export function ToolTimeline() {
  const allEvents = useEventStore((s) => s.events);
  const [kindFilter, setKindFilter] = useState<ToolEventKind | "all">("all");

  const toolEvents = useMemo(
    () =>
      allEvents.filter((e) => {
        if (!e.event.startsWith("tool.")) return false;
        if (kindFilter === "all") return true;
        return e.event === `tool.${kindFilter}`;
      }),
    [allEvents, kindFilter]
  );

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.heading}>Tool Timeline</h2>
          <p style={styles.subheading}>Track tool execution events and results</p>
        </div>
      </div>

      <div style={styles.filterBar}>
        <div style={styles.pillGroup}>
          <button
            style={{
              ...styles.pill,
              ...(kindFilter === "all" ? styles.pillActive : {}),
            }}
            onClick={() => setKindFilter("all")}
          >
            All
            <span style={styles.pillCount}>{toolEvents.length}</span>
          </button>
          {TOOL_EVENT_KINDS.map((kind) => {
            const count = allEvents.filter(
              (e) => e.event === `tool.${kind}`
            ).length;
            return (
              <button
                key={kind}
                style={{
                  ...styles.pill,
                  ...(kindFilter === kind ? styles.pillActive : {}),
                }}
                onClick={() =>
                  setKindFilter(kindFilter === kind ? "all" : (kind as ToolEventKind))
                }
              >
                <span
                  style={{
                    ...styles.kindDot,
                    background: KIND_COLORS[kind as ToolEventKind],
                  }}
                />
                {kind}
                <span style={styles.pillCount}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {toolEvents.length === 0 ? (
        <div style={styles.empty}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="1.5" style={{ opacity: 0.5 }}>
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
          </svg>
          <span>No tool events yet</span>
        </div>
      ) : (
        <div style={styles.list}>
          {toolEvents.map((ev, i) => (
            <ToolEventRow
              key={`${ev.seq}-${ev.event}`}
              event={ev}
              index={i}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolEventRow({
  event,
  index,
}: {
  event: EventEntry;
  index: number;
}) {
  const kind = event.event.replace("tool.", "") as ToolEventKind;
  const color = KIND_COLORS[kind] ?? "var(--color-muted)";
  const icon = KIND_ICONS[kind] ?? "•";
  const time = new Date(event.createdAt).toLocaleTimeString();
  const [expanded, setExpanded] = useState(false);

  const payload = event.payload as Record<string, unknown> | undefined;
  const toolName = payload?.toolName ?? payload?.name ?? "unknown";
  const callId = payload?.callId ?? payload?.call_id;
  const durationMs = payload?.durationMs ?? payload?.duration;
  const error = payload?.error as string | undefined;
  const output = payload?.output ?? payload?.result;

  return (
    <div
      style={{
        ...styles.card,
        animation: `slideUp ${Math.min(0.1 + index * 0.03, 0.3)}s ease`,
      }}
    >
      <div style={styles.cardHeader} onClick={() => setExpanded(!expanded)}>
        <span
          style={{
            ...styles.eventIcon,
            color,
            background: `${color}12`,
          }}
        >
          {icon}
        </span>
        <span style={{ ...styles.toolName, color }}>{String(toolName)}</span>
        {callId !== undefined && callId !== null && (
          <span style={styles.callId}>{String(callId).slice(0, 8)}</span>
        )}
        {durationMs !== undefined && (
          <span style={styles.duration}>{Number(durationMs)}ms</span>
        )}
        <span style={styles.time}>{time}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-muted)"
          strokeWidth="2"
          style={{
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform var(--transition-fast)",
          }}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>

      {expanded && (
        <div style={styles.cardBody}>
          {error && (
            <div style={styles.errorBanner}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
              {error}
            </div>
          )}
          {output !== undefined && (
            <div style={styles.outputSection}>
              <span style={styles.outputLabel}>Output</span>
              <pre style={styles.pre}>
                {typeof output === "string"
                  ? output
                  : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
          {payload && (
            <div style={styles.outputSection}>
              <span style={styles.outputLabel}>Payload</span>
              <pre style={styles.pre}>
                {JSON.stringify(payload, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 960,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  heading: {
    fontSize: 20,
    fontWeight: 700,
    color: "var(--color-text)",
    marginBottom: 4,
  },
  subheading: {
    fontSize: 13,
    color: "var(--color-muted)",
  },
  filterBar: {
    marginBottom: 16,
  },
  pillGroup: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
  },
  pill: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-full)",
    color: "var(--color-text-secondary)",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    transition: "all var(--transition-fast)",
  },
  pillActive: {
    background: "var(--color-accent)",
    borderColor: "var(--color-accent)",
    color: "#fff",
  },
  pillCount: {
    fontSize: 10,
    padding: "1px 5px",
    background: "rgba(0,0,0,0.1)",
    borderRadius: "var(--radius-full)",
  },
  kindDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: "40px 16px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-lg)",
    color: "var(--color-muted)",
    fontSize: 13,
    boxShadow: "var(--shadow-sm)",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  card: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    boxShadow: "var(--shadow-sm)",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    cursor: "pointer",
    fontSize: 12,
    transition: "background var(--transition-fast)",
  },
  eventIcon: {
    width: 24,
    height: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-sm)",
    fontSize: 11,
    flexShrink: 0,
  },
  toolName: {
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    fontSize: 12,
  },
  callId: {
    fontSize: 10,
    fontFamily: "var(--font-mono)",
    color: "var(--color-muted)",
    padding: "2px 6px",
    background: "var(--color-surface-secondary)",
    borderRadius: "var(--radius-sm)",
  },
  duration: {
    fontSize: 10,
    color: "var(--color-muted)",
    padding: "2px 6px",
    background: "var(--color-surface-secondary)",
    borderRadius: "var(--radius-sm)",
  },
  time: {
    marginLeft: "auto",
    fontSize: 11,
    color: "var(--color-muted)",
  },
  cardBody: {
    padding: "0 14px 14px",
    borderTop: "1px solid var(--color-border-light)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    animation: "fadeIn 0.15s ease",
  },
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 10px",
    background: "var(--color-error-light)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-error)",
    fontSize: 12,
    marginTop: 10,
  },
  outputSection: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    marginTop: 6,
  },
  outputLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: "var(--color-text-secondary)",
  },
  pre: {
    padding: 10,
    background: "var(--color-surface-secondary)",
    borderRadius: "var(--radius-sm)",
    fontSize: 11,
    color: "var(--color-text-secondary)",
    overflow: "auto",
    maxHeight: 160,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    fontFamily: "var(--font-mono)",
    lineHeight: 1.5,
  },
};
