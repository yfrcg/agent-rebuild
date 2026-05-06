import { useMemo, useState } from "react";
import { useEventStore, type EventEntry } from "../../stores/eventStore";
import { useSessionStore } from "../../stores/sessionStore";

const EVENT_COLORS: Record<string, string> = {
  "run.started": "var(--color-accent)",
  "run.progress": "var(--color-accent)",
  "run.finished": "var(--color-success)",
  "run.failed": "var(--color-error)",
  "run.cancelled": "var(--color-cancelled)",
  "chat.delta": "var(--color-muted)",
  "chat.completed": "var(--color-success)",
  "tool.started": "var(--color-warning)",
  "tool.finished": "var(--color-success)",
  "tool.failed": "var(--color-error)",
  "tool.denied": "var(--color-error)",
  "approval.required": "var(--color-warning)",
  "approval.confirmed": "var(--color-success)",
  "approval.rejected": "var(--color-error)",
  "session.updated": "var(--color-accent)",
  "audit.append": "var(--color-muted)",
  "server.shutdown": "var(--color-error)",
  "state.resync_required": "var(--color-warning)",
};

const EVENT_ICONS: Record<string, string> = {
  "run.started": "▶",
  "run.progress": "⟳",
  "run.finished": "✓",
  "run.failed": "✗",
  "run.cancelled": "⊘",
  "chat.delta": "…",
  "chat.completed": "✓",
  "tool.started": "⚡",
  "tool.finished": "✓",
  "tool.failed": "✗",
  "tool.denied": "⊘",
  "approval.required": "?",
  "approval.confirmed": "✓",
  "approval.rejected": "✗",
  "session.updated": "↻",
  "audit.append": "📝",
  "server.shutdown": "⏻",
  "state.resync_required": "⟳",
};

export function TimelinePanel() {
  const filter = useEventStore((s) => s.filter);
  const setFilter = useEventStore((s) => s.setFilter);
  const clearEvents = useEventStore((s) => s.clearEvents);
  const allEvents = useEventStore((s) => s.events);
  const events = useMemo(
    () =>
      allEvents.filter((e) => {
        if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
        if (filter.runId && e.runId !== filter.runId) return false;
        if (filter.eventType && e.event !== filter.eventType) return false;
        return true;
      }),
    [allEvents, filter]
  );
  const sessions = useSessionStore((s) => s.sessions);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div style={styles.headerTop}>
          <div style={styles.headerLeft}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span style={styles.title}>Events</span>
            <span style={styles.count}>{events.length}</span>
          </div>
          <div style={styles.headerActions}>
            <button
              style={{
                ...styles.miniBtn,
                ...(autoScroll ? styles.miniBtnActive : {}),
              }}
              onClick={() => setAutoScroll(!autoScroll)}
              title="Auto scroll"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <polyline points="19 12 12 19 5 12"/>
              </svg>
            </button>
            <button style={styles.clearBtn} onClick={clearEvents} title="Clear events">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        <select
          style={styles.select}
          value={filter.sessionId ?? ""}
          onChange={(e) =>
            setFilter({
              ...filter,
              sessionId: e.target.value || undefined,
            })
          }
        >
          <option value="">All Sessions</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div style={styles.list}>
        {events.length === 0 && (
          <div style={styles.empty}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="1.5" style={{ opacity: 0.5 }}>
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span>No events yet</span>
          </div>
        )}
        {events.map((ev) => (
          <EventRow
            key={`${ev.seq}-${ev.event}`}
            event={ev}
            expanded={expanded === `${ev.seq}-${ev.event}`}
            onToggle={() =>
              setExpanded(
                expanded === `${ev.seq}-${ev.event}`
                  ? null
                  : `${ev.seq}-${ev.event}`
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function EventRow({
  event,
  expanded,
  onToggle,
}: {
  event: EventEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const color = EVENT_COLORS[event.event] ?? "var(--color-muted)";
  const icon = EVENT_ICONS[event.event] ?? "•";
  const time = new Date(event.createdAt).toLocaleTimeString();
  const hasPayload =
    event.payload !== undefined && event.payload !== null;

  return (
    <div
      style={{
        ...styles.event,
        ...(expanded ? styles.eventExpanded : {}),
      }}
      onClick={onToggle}
    >
      <div style={styles.eventRow}>
        <span
          style={{
            ...styles.eventIcon,
            color,
            background: `${color}15`,
          }}
        >
          {icon}
        </span>
        <span style={{ ...styles.badge, borderColor: color, color }}>
          {event.event}
        </span>
        <span style={styles.time}>{time}</span>
      </div>
      {expanded && hasPayload && (
        <pre style={styles.payload}>
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 300,
    minWidth: 300,
    background: "var(--color-surface)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderLeft: "1px solid var(--color-border-light)",
    animation: "slideInRight 0.2s ease",
  },
  header: {
    padding: "10px 12px",
    borderBottom: "1px solid var(--color-border-light)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  headerTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  title: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text)",
  },
  count: {
    fontSize: 10,
    padding: "1px 6px",
    background: "var(--color-surface-secondary)",
    color: "var(--color-muted)",
    borderRadius: "var(--radius-full)",
    fontWeight: 600,
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  miniBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    background: "none",
    border: "none",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-muted)",
    cursor: "pointer",
  },
  miniBtnActive: {
    background: "var(--color-accent-light)",
    color: "var(--color-accent)",
  },
  clearBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    background: "none",
    border: "none",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-muted)",
    cursor: "pointer",
  },
  select: {
    width: "100%",
    padding: "5px 8px",
    background: "var(--color-surface-secondary)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-text-secondary)",
    fontSize: 11,
    outline: "none",
  },
  list: {
    flex: 1,
    overflow: "auto",
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: "32px 16px",
    color: "var(--color-muted)",
    fontSize: 12,
  },
  event: {
    padding: "8px 12px",
    borderBottom: "1px solid var(--color-border-light)",
    cursor: "pointer",
    fontSize: 12,
    transition: "background var(--transition-fast)",
  },
  eventExpanded: {
    background: "var(--color-surface-secondary)",
  },
  eventRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  eventIcon: {
    width: 20,
    height: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-sm)",
    fontSize: 10,
    flexShrink: 0,
  },
  badge: {
    padding: "2px 6px",
    border: "1px solid",
    borderRadius: "var(--radius-sm)",
    fontSize: 10,
    fontWeight: 500,
    whiteSpace: "nowrap",
  },
  time: {
    marginLeft: "auto",
    color: "var(--color-muted)",
    fontSize: 10,
    flexShrink: 0,
  },
  payload: {
    marginTop: 6,
    padding: 8,
    background: "var(--color-bg)",
    borderRadius: "var(--radius-sm)",
    fontSize: 11,
    color: "var(--color-text-secondary)",
    overflow: "auto",
    maxHeight: 160,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    animation: "fadeIn 0.15s ease",
  },
};
