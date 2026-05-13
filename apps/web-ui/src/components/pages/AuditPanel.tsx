/**
 * ?????CS336 ???
 * ???apps/web-ui/src/components/pages/AuditPanel.tsx
 * ???Web UI ?????
 * ????????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import { useState, useEffect } from "react";
import { useGateway } from "../../providers/GatewayProvider";
import { GatewayError } from "@ws-client/types";

type AuditEntry = {
  type?: string;
  ts?: string;
  sessionId?: string;
  runId?: string;
  detail?: Record<string, unknown>;
};

export function AuditPanel() {
  const client = useGateway();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);
  const [typeFilter, setTypeFilter] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.auditTail({ limit, type: typeFilter || undefined });
      const r = result as Record<string, unknown>;
      const rawEntries = (r.entries ?? r.logs ?? []) as Array<
        Record<string, unknown>
      >;
      setEntries(
        rawEntries.map((e) => ({
          type: e.type as string | undefined,
          ts: (e.ts ?? e.timestamp ?? e.createdAt) as string | undefined,
          sessionId: e.sessionId as string | undefined,
          runId: e.runId as string | undefined,
          detail: e.detail as Record<string, unknown> | undefined,
        }))
      );
    } catch (err) {
      if (err instanceof GatewayError) {
        setError(`[${err.code}] ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load logs");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [limit, typeFilter]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.heading}>Audit Logs</h2>
          <p style={styles.subheading}>System audit trail and activity history</p>
        </div>
      </div>

      <div style={styles.controls}>
        <div style={styles.filterGroup}>
          <div style={styles.searchWrapper}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              style={styles.filterInput}
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              placeholder="Filter by type…"
            />
          </div>
          <select
            style={styles.limitSelect}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            <option value={20}>20 entries</option>
            <option value={50}>50 entries</option>
            <option value={100}>100 entries</option>
            <option value={200}>200 entries</option>
          </select>
        </div>
        <button
          style={styles.refreshBtn}
          onClick={fetchLogs}
          disabled={loading}
        >
          {loading ? (
            <span style={styles.spinner} />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          )}
          Refresh
        </button>
      </div>

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

      {loading && entries.length === 0 ? (
        <div style={styles.loadingCard}>
          <div style={styles.loadingSpinner} />
          <span>Loading audit logs…</span>
        </div>
      ) : entries.length === 0 ? (
        <div style={styles.empty}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="1.5" style={{ opacity: 0.5 }}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
          </svg>
          <span>No audit entries found</span>
        </div>
      ) : (
        <div style={styles.list}>
          {entries.map((e, i) => (
            <div
              key={i}
              style={{
                ...styles.card,
                animation: `slideUp ${Math.min(0.1 + i * 0.03, 0.3)}s ease`,
              }}
            >
              <div
                style={styles.cardHeader}
                onClick={() => setExpanded(expanded === i ? null : i)}
              >
                <span style={styles.typeBadge}>{e.type ?? "unknown"}</span>
                <span style={styles.time}>
                  {e.ts ? new Date(e.ts).toLocaleString() : ""}
                </span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--color-muted)"
                  strokeWidth="2"
                  style={{
                    transform: expanded === i ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform var(--transition-fast)",
                    marginLeft: "auto",
                  }}
                >
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </div>
              {expanded === i && e.detail && (
                <pre style={styles.detail}>
                  {JSON.stringify(e.detail, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 1000,
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
  controls: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  filterGroup: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flex: 1,
  },
  searchWrapper: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    flex: 1,
    maxWidth: 260,
  },
  filterInput: {
    flex: 1,
    background: "none",
    border: "none",
    color: "var(--color-text)",
    fontSize: 12,
    outline: "none",
  },
  limitSelect: {
    padding: "7px 10px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-text-secondary)",
    fontSize: 12,
    outline: "none",
  },
  refreshBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    background: "var(--color-accent)",
    border: "none",
    borderRadius: "var(--radius-md)",
    color: "#fff",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
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
    marginBottom: 16,
    animation: "fadeIn 0.2s ease",
  },
  loadingCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    padding: 40,
    color: "var(--color-muted)",
    fontSize: 13,
  },
  loadingSpinner: {
    width: 24,
    height: 24,
    border: "2px solid var(--color-border)",
    borderTopColor: "var(--color-accent)",
    borderRadius: "50%",
    animation: "spin 0.6s linear infinite",
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
    gap: 10,
    padding: "10px 14px",
    cursor: "pointer",
    fontSize: 12,
    transition: "background var(--transition-fast)",
  },
  typeBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: "3px 10px",
    background: "var(--color-accent-light)",
    color: "var(--color-accent)",
    borderRadius: "var(--radius-full)",
    whiteSpace: "nowrap",
  },
  time: {
    color: "var(--color-muted)",
    fontSize: 11,
  },
  detail: {
    padding: "0 14px 14px",
    fontSize: 11,
    color: "var(--color-text-secondary)",
    fontFamily: "var(--font-mono)",
    overflow: "auto",
    maxHeight: 200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    lineHeight: 1.5,
    borderTop: "1px solid var(--color-border-light)",
    paddingTop: 10,
    margin: "0 14px",
    animation: "fadeIn 0.15s ease",
  },
};
