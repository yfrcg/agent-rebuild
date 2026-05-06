import { useEffect, useState } from "react";
import { useGateway } from "../../providers/GatewayProvider";
import { useConnectionStore } from "../../stores/connectionStore";

export function Dashboard() {
  const client = useGateway();
  const capabilities = useConnectionStore((s) => s.capabilities);
  const [runtimeStatus, setRuntimeStatus] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [tools, setTools] = useState<
    Array<{
      name: string;
      description?: string;
      category?: string;
      riskLevel?: string;
      source?: string;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [status, toolList] = await Promise.all([
          client.runtimeStatus(),
          client.toolList(),
        ]);
        if (!cancelled) {
          setRuntimeStatus(status as Record<string, unknown>);
          const tl = toolList as Record<string, unknown>;
          setTools(
            (tl.tools as Array<Record<string, unknown>>).map((t) => ({
              name: String(t.name ?? ""),
              description: t.description as string | undefined,
              category: t.category as string | undefined,
              riskLevel: t.riskLevel as string | undefined,
              source: t.source as string | undefined,
            }))
          );
        }
      } catch {
        // non-critical
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = [...new Set(tools.map((t) => t.category).filter(Boolean))];
  const filteredTools = tools.filter((t) => {
    if (searchTerm && !t.name.toLowerCase().includes(searchTerm.toLowerCase()) &&
        !t.description?.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    if (selectedCategory && t.category !== selectedCategory) return false;
    return true;
  });

  return (
    <div style={styles.container}>
      <div style={styles.pageHeader}>
        <div>
          <h2 style={styles.heading}>Dashboard</h2>
          <p style={styles.subheading}>System overview and tool management</p>
        </div>
      </div>

      {loading ? (
        <div style={styles.loadingCard}>
          <div style={styles.loadingSpinner} />
          <span>Loading dashboard data…</span>
        </div>
      ) : (
        <>
          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
              Capabilities
            </h3>
            <div style={styles.capGrid}>
              {capabilities
                ? Object.entries(capabilities).map(([key, val]) => (
                    <div key={key} style={{
                      ...styles.capCard,
                      ...(val ? styles.capCardActive : styles.capCardInactive),
                    }}>
                      <div style={styles.capIcon}>
                        {val ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                            <polyline points="22 4 12 14.01 9 11.01"/>
                          </svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="2">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="15" y1="9" x2="9" y2="15"/>
                            <line x1="9" y1="9" x2="15" y2="15"/>
                          </svg>
                        )}
                      </div>
                      <span style={styles.capName}>{key}</span>
                      <span style={{
                        ...styles.capStatus,
                        color: val ? "var(--color-success)" : "var(--color-muted)",
                      }}>
                        {val ? "Active" : "Inactive"}
                      </span>
                    </div>
                  ))
                : <div style={styles.emptyHint}>No capabilities data available</div>}
            </div>
          </section>

          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
              Runtime Status
            </h3>
            <div style={styles.statusCard}>
              <pre style={styles.pre}>
                {runtimeStatus
                  ? JSON.stringify(runtimeStatus, null, 2)
                  : "No status available"}
              </pre>
            </div>
          </section>

          <section style={styles.section}>
            <div style={styles.toolsHeader}>
              <h3 style={styles.sectionTitle}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                </svg>
                Tools
                <span style={styles.toolCount}>{filteredTools.length}/{tools.length}</span>
              </h3>
              <div style={styles.toolsControls}>
                <div style={styles.searchWrapper}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="2">
                    <circle cx="11" cy="11" r="8"/>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <input
                    style={styles.searchInput}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search tools…"
                  />
                </div>
                <div style={styles.categoryPills}>
                  <button
                    style={{
                      ...styles.pill,
                      ...(selectedCategory === null ? styles.pillActive : {}),
                    }}
                    onClick={() => setSelectedCategory(null)}
                  >
                    All
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      style={{
                        ...styles.pill,
                        ...(selectedCategory === cat ? styles.pillActive : {}),
                      }}
                      onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat ?? null)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div style={styles.toolGrid}>
              {filteredTools.map((t) => (
                <div key={t.name} style={styles.toolCard}>
                  <div style={styles.toolCardHeader}>
                    <span style={styles.toolName}>{t.name}</span>
                    <div style={styles.toolBadges}>
                      {t.category && (
                        <span style={styles.toolCategory}>{t.category}</span>
                      )}
                      {t.riskLevel && (
                        <span
                          style={{
                            ...styles.toolRisk,
                            color:
                              t.riskLevel === "high"
                                ? "var(--color-error)"
                                : t.riskLevel === "medium"
                                  ? "var(--color-warning)"
                                  : "var(--color-muted)",
                            background:
                              t.riskLevel === "high"
                                ? "var(--color-error-light)"
                                : t.riskLevel === "medium"
                                  ? "var(--color-warning-light)"
                                  : "var(--color-surface-secondary)",
                          }}
                        >
                          {t.riskLevel}
                        </span>
                      )}
                    </div>
                  </div>
                  {t.description && (
                    <div style={styles.toolDesc}>{t.description}</div>
                  )}
                  {t.source && (
                    <div style={styles.toolSource}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                      </svg>
                      {t.source}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 1100,
  },
  pageHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
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
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 15,
    fontWeight: 600,
    color: "var(--color-text)",
    marginBottom: 14,
  },
  capGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: 10,
  },
  capCard: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "12px 14px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-sm)",
  },
  capCardActive: {
    borderColor: "var(--color-success)",
    background: "var(--color-success-light)",
  },
  capCardInactive: {
    opacity: 0.6,
  },
  capIcon: {
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--color-surface)",
    borderRadius: "var(--radius-sm)",
  },
  capName: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--color-text)",
    textTransform: "capitalize",
  },
  capStatus: {
    fontSize: 10,
    fontWeight: 500,
    marginLeft: "auto",
  },
  emptyHint: {
    color: "var(--color-muted)",
    fontSize: 13,
    padding: 16,
  },
  statusCard: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    boxShadow: "var(--shadow-sm)",
  },
  pre: {
    padding: 14,
    fontSize: 12,
    color: "var(--color-text-secondary)",
    overflow: "auto",
    maxHeight: 200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    fontFamily: "var(--font-mono)",
    lineHeight: 1.6,
  },
  toolsHeader: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  toolCount: {
    fontSize: 11,
    padding: "2px 8px",
    background: "var(--color-surface-secondary)",
    color: "var(--color-muted)",
    borderRadius: "var(--radius-full)",
    fontWeight: 500,
    marginLeft: 4,
  },
  toolsControls: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  },
  searchWrapper: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    minWidth: 200,
  },
  searchInput: {
    flex: 1,
    background: "none",
    border: "none",
    color: "var(--color-text)",
    fontSize: 12,
    outline: "none",
  },
  categoryPills: {
    display: "flex",
    gap: 4,
    flexWrap: "wrap",
  },
  pill: {
    padding: "4px 10px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-full)",
    color: "var(--color-text-secondary)",
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
    transition: "all var(--transition-fast)",
  },
  pillActive: {
    background: "var(--color-accent)",
    borderColor: "var(--color-accent)",
    color: "#fff",
  },
  toolGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: 10,
    marginTop: 14,
  },
  toolCard: {
    padding: "14px 16px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-md)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    boxShadow: "var(--shadow-sm)",
    transition: "all var(--transition-fast)",
  },
  toolCardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toolName: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text)",
    fontFamily: "var(--font-mono)",
  },
  toolBadges: {
    display: "flex",
    gap: 4,
  },
  toolCategory: {
    fontSize: 10,
    padding: "2px 8px",
    background: "var(--color-accent-light)",
    color: "var(--color-accent)",
    borderRadius: "var(--radius-full)",
    fontWeight: 500,
  },
  toolRisk: {
    fontSize: 10,
    padding: "2px 8px",
    borderRadius: "var(--radius-full)",
    fontWeight: 500,
  },
  toolDesc: {
    fontSize: 12,
    color: "var(--color-text-secondary)",
    lineHeight: 1.5,
  },
  toolSource: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 10,
    color: "var(--color-muted)",
  },
};
