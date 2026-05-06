import { useState } from "react";
import { useGateway } from "../../providers/GatewayProvider";
import { useSessionStore } from "../../stores/sessionStore";
import { GatewayError } from "@ws-client/types";

type MemorySearchResult = {
  id: string;
  text?: string;
  filePath?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

type MemoryWriteResult = {
  status?: string;
  chunkId?: string;
  count?: number;
};

export function MemoryPanel() {
  const client = useGateway();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [writeText, setWriteText] = useState("");
  const [writeScope, setWriteScope] = useState<"daily" | "long_term" | "auto">(
    "auto"
  );
  const [writeResult, setWriteResult] = useState<MemoryWriteResult | null>(
    null
  );
  const [writeLoading, setWriteLoading] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchError(null);
    setSearchResults([]);
    try {
      const result = await client.memorySearch(
        searchQuery.trim()
      );
      const r = result as Record<string, unknown>;
      const matches = (r.matches ?? r.results ?? []) as Array<
        Record<string, unknown>
      >;
      setSearchResults(
        matches.map((m) => ({
          id: String(m.id ?? m.chunkId ?? ""),
          text: m.text as string | undefined,
          filePath: (m.filePath ?? m.source ?? m.path) as string | undefined,
          score: m.score as number | undefined,
          metadata: m.metadata as Record<string, unknown> | undefined,
        }))
      );
    } catch (err) {
      if (err instanceof GatewayError) {
        setSearchError(`[${err.code}] ${err.message}`);
      } else {
        setSearchError(err instanceof Error ? err.message : "Search failed");
      }
    } finally {
      setSearchLoading(false);
    }
  };

  const handleWrite = async () => {
    if (!writeText.trim()) return;
    setWriteLoading(true);
    setWriteError(null);
    setWriteResult(null);
    try {
      const result = await client.memoryWrite(
        currentSessionId ?? "",
        writeText.trim(),
        writeScope
      );
      setWriteResult(result as MemoryWriteResult);
      setWriteText("");
    } catch (err) {
      if (err instanceof GatewayError) {
        setWriteError(`[${err.code}] ${err.message}`);
      } else {
        setWriteError(err instanceof Error ? err.message : "Write failed");
      }
    } finally {
      setWriteLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.pageHeader}>
        <div>
          <h2 style={styles.heading}>Memory</h2>
          <p style={styles.subheading}>Search and manage agent memory</p>
        </div>
      </div>

      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Search Memory
        </h3>
        <div style={styles.searchBar}>
          <input
            style={styles.searchInput}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search for memories…"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
          />
          <button
            style={styles.searchBtn}
            onClick={handleSearch}
            disabled={searchLoading || !searchQuery.trim()}
          >
            {searchLoading ? (
              <span style={styles.spinner} />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            )}
            {searchLoading ? "Searching…" : "Search"}
          </button>
        </div>
        {searchError && (
          <div style={styles.errorBox}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
            {searchError}
          </div>
        )}
        {searchResults.length > 0 && (
          <div style={styles.results}>
            <div style={styles.resultsHeader}>
              <span>{searchResults.length} results found</span>
            </div>
            {searchResults.map((r) => (
              <div key={r.id} style={styles.resultCard}>
                <div style={styles.resultHeader}>
                  <span style={styles.resultId}>{r.id}</span>
                  {r.score !== undefined && (
                    <span style={styles.scoreBadge}>
                      {(r.score * 100).toFixed(1)}%
                    </span>
                  )}
                </div>
                {r.filePath && (
                  <div style={styles.filePath}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    {r.filePath}
                  </div>
                )}
                {r.text && <div style={styles.resultText}>{r.text}</div>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          Write Memory
        </h3>
        <textarea
          style={styles.textarea}
          value={writeText}
          onChange={(e) => setWriteText(e.target.value)}
          placeholder="Enter content to save to memory…"
          rows={5}
        />
        <div style={styles.writeOptions}>
          <span style={styles.scopeLabel}>Scope:</span>
          <div style={styles.scopePills}>
            {(["auto", "daily", "long_term"] as const).map((scope) => (
              <button
                key={scope}
                style={{
                  ...styles.pill,
                  ...(writeScope === scope ? styles.pillActive : {}),
                }}
                onClick={() => setWriteScope(scope)}
              >
                {scope === "long_term" ? "Long Term" : scope.charAt(0).toUpperCase() + scope.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <button
          style={styles.writeBtn}
          onClick={handleWrite}
          disabled={writeLoading || !writeText.trim()}
        >
          {writeLoading ? (
            <span style={styles.spinnerLight} />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          )}
          {writeLoading ? "Writing…" : "Save to Memory"}
        </button>
        {writeError && (
          <div style={styles.errorBox}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
            {writeError}
          </div>
        )}
        {writeResult && (
          <div style={styles.successBox}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Memory saved successfully
            {writeResult.chunkId && (
              <span style={styles.resultDetail}>Chunk: {writeResult.chunkId}</span>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 860,
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
  section: {
    marginBottom: 28,
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-lg)",
    padding: 20,
    boxShadow: "var(--shadow-sm)",
  },
  sectionTitle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 15,
    fontWeight: 600,
    color: "var(--color-text)",
    marginBottom: 16,
  },
  searchBar: {
    display: "flex",
    gap: 8,
  },
  searchInput: {
    flex: 1,
    padding: "10px 14px",
    background: "var(--color-surface-secondary)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-md)",
    color: "var(--color-text)",
    fontSize: 13,
    outline: "none",
    fontFamily: "var(--font-sans)",
  },
  searchBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "10px 18px",
    background: "var(--color-accent)",
    border: "none",
    borderRadius: "var(--radius-md)",
    color: "#fff",
    fontSize: 13,
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
    marginTop: 12,
    animation: "fadeIn 0.2s ease",
  },
  results: {
    marginTop: 16,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  resultsHeader: {
    fontSize: 12,
    color: "var(--color-muted)",
    fontWeight: 500,
  },
  resultCard: {
    padding: "12px 14px",
    background: "var(--color-surface-secondary)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-md)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    animation: "slideUp 0.2s ease",
  },
  resultHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  resultId: {
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    color: "var(--color-accent)",
    fontWeight: 600,
  },
  scoreBadge: {
    fontSize: 10,
    padding: "2px 8px",
    background: "var(--color-success-light)",
    color: "var(--color-success)",
    borderRadius: "var(--radius-full)",
    fontWeight: 600,
  },
  filePath: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    color: "var(--color-muted)",
  },
  resultText: {
    fontSize: 12,
    color: "var(--color-text-secondary)",
    lineHeight: 1.5,
  },
  textarea: {
    width: "100%",
    padding: "10px 14px",
    background: "var(--color-surface-secondary)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-md)",
    color: "var(--color-text)",
    fontSize: 13,
    outline: "none",
    fontFamily: "var(--font-sans)",
    resize: "vertical",
    lineHeight: 1.5,
  },
  writeOptions: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
  },
  scopeLabel: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--color-text-secondary)",
  },
  scopePills: {
    display: "flex",
    gap: 4,
  },
  pill: {
    padding: "5px 12px",
    background: "var(--color-surface-secondary)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-full)",
    color: "var(--color-text-secondary)",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    transition: "all var(--transition-fast)",
  },
  pillActive: {
    background: "var(--color-accent)",
    borderColor: "var(--color-accent)",
    color: "#fff",
  },
  writeBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    width: "100%",
    padding: "10px 16px",
    background: "var(--color-accent)",
    border: "none",
    borderRadius: "var(--radius-md)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    marginTop: 12,
  },
  successBox: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    background: "var(--color-success-light)",
    border: "1px solid var(--color-success)",
    borderRadius: "var(--radius-md)",
    color: "var(--color-success)",
    fontSize: 13,
    marginTop: 12,
    animation: "fadeIn 0.2s ease",
  },
  resultDetail: {
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    marginLeft: 4,
    opacity: 0.8,
  },
  spinner: {
    width: 14,
    height: 14,
    border: "2px solid rgba(255,255,255,0.3)",
    borderTopColor: "#fff",
    borderRadius: "50%",
    animation: "spin 0.6s linear infinite",
  },
  spinnerLight: {
    width: 14,
    height: 14,
    border: "2px solid rgba(255,255,255,0.3)",
    borderTopColor: "#fff",
    borderRadius: "50%",
    animation: "spin 0.6s linear infinite",
  },
};
