import { useState } from "react";
import { useSessionStore, type SessionEntry } from "../../stores/sessionStore";
import { useGateway } from "../../providers/GatewayProvider";

export function SessionSidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);
  const updateSession = useSessionStore((s) => s.updateSession);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(false);

  const client = useGateway();

  const filteredSessions = sessions.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(false);
    try {
      const result = await client.sessionCreate(newName.trim());
      const created = result as Record<string, unknown>;
      const sid = String(created.id ?? created.sessionId ?? "");
      if (sid) {
        setCurrentSession(sid);
        const list = await client.sessionList();
        useSessionStore
          .getState()
          .setSessions(
            (list as unknown[]).map((s) => {
              const se = s as Record<string, unknown>;
              return {
                id: String(se.id ?? ""),
                name: String(se.name ?? "unnamed"),
                messageCount: Number(se.messageCount ?? 0),
                updatedAt: String(se.updatedAt ?? ""),
                permission: se.permission as string | undefined,
                projectBound: Boolean(se.projectBound),
              };
            })
          );
      }
    } catch {
      // error handled by store / provider
    }
    setNewName("");
  };

  const handleBindProject = async (sessionId: string) => {
    const dir = prompt("Enter project directory path:");
    if (!dir) return;
    try {
      const result = await client.sessionBindProject(sessionId, dir);
      const r = result as Record<string, unknown>;
      updateSession(sessionId, {
        projectBound: true,
        permission: r.permission as string,
      });
    } catch {
      // error toast or notification could be added
    }
  };

  if (collapsed) {
    return (
      <div style={styles.collapsedSidebar}>
        <button
          style={styles.expandBtn}
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
        <button
          style={styles.collapsedNewBtn}
          onClick={() => {
            setCollapsed(false);
            setCreating(true);
          }}
          title="New Session"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
        <div style={styles.collapsedList}>
          {sessions.map((s) => (
            <button
              key={s.id}
              style={{
                ...styles.collapsedItem,
                ...(s.id === currentSessionId ? styles.collapsedItemActive : {}),
              }}
              onClick={() => setCurrentSession(s.id)}
              title={s.name}
            >
              {s.name.charAt(0).toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.sidebar}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <span style={styles.title}>Sessions</span>
          <span style={styles.count}>{sessions.length}</span>
        </div>
        <div style={styles.headerActions}>
          <button
            style={styles.iconBtn}
            onClick={() => setCreating(true)}
            title="New Session"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
          <button
            style={styles.iconBtn}
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
        </div>
      </div>

      {creating && (
        <div style={styles.createRow}>
          <div style={styles.createInputWrapper}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="2" style={{ flexShrink: 0 }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <input
              style={styles.createInput}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Enter session name…"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
              autoFocus
            />
          </div>
          <div style={styles.createActions}>
            <button
              style={styles.createConfirmBtn}
              onClick={handleCreate}
              disabled={!newName.trim()}
            >
              Create
            </button>
            <button
              style={styles.createCancelBtn}
              onClick={() => {
                setCreating(false);
                setNewName("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={styles.searchRow}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="2" style={{ flexShrink: 0 }}>
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          style={styles.searchInput}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sessions…"
        />
        {search && (
          <button
            style={styles.clearSearchBtn}
            onClick={() => setSearch("")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
      </div>

      <div style={styles.list}>
        {filteredSessions.length === 0 && (
          <div style={styles.empty}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="1.5" style={{ opacity: 0.5 }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span>{search ? "No matching sessions" : "No sessions yet"}</span>
            {!search && (
              <button
                style={styles.emptyAction}
                onClick={() => setCreating(true)}
              >
                Create your first session
              </button>
            )}
          </div>
        )}
        {filteredSessions.map((s) => (
          <SessionItem
            key={s.id}
            session={s}
            active={s.id === currentSessionId}
            onSelect={() => setCurrentSession(s.id)}
            onBindProject={() => handleBindProject(s.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SessionItem({
  session,
  active,
  onSelect,
  onBindProject,
}: {
  session: SessionEntry;
  active: boolean;
  onSelect: () => void;
  onBindProject: () => void;
}) {
  return (
    <div
      style={{
        ...styles.item,
        ...(active ? styles.itemActive : {}),
      }}
      onClick={onSelect}
    >
      <div style={styles.itemHeader}>
        <div style={styles.itemAvatar}>
          {session.name.charAt(0).toUpperCase()}
        </div>
        <div style={styles.itemContent}>
          <div style={styles.itemName}>{session.name}</div>
          <div style={styles.itemMeta}>
            <span style={styles.metaItem}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              {session.messageCount}
            </span>
            {session.projectBound && (
              <span style={styles.boundBadge}>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                bound
              </span>
            )}
            {session.permission && (
              <span style={styles.permBadge}>{session.permission}</span>
            )}
          </div>
        </div>
      </div>
      {!session.projectBound && (
        <button
          style={styles.bindBtn}
          onClick={(e) => {
            e.stopPropagation();
            onBindProject();
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Bind
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: 280,
    minWidth: 280,
    background: "var(--color-surface)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderRight: "1px solid var(--color-border-light)",
  },
  collapsedSidebar: {
    width: 52,
    minWidth: 52,
    background: "var(--color-surface)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "8px 0",
    gap: 8,
    borderRight: "1px solid var(--color-border-light)",
  },
  expandBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    background: "none",
    border: "none",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-muted)",
    cursor: "pointer",
  },
  collapsedNewBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    background: "var(--color-accent-light)",
    border: "none",
    borderRadius: "var(--radius-md)",
    color: "var(--color-accent)",
    cursor: "pointer",
  },
  collapsedList: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "4px 8px",
    overflow: "auto",
    alignItems: "center",
  },
  collapsedItem: {
    width: 36,
    height: 36,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--color-surface-secondary)",
    border: "2px solid transparent",
    borderRadius: "var(--radius-md)",
    color: "var(--color-text-secondary)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    transition: "all var(--transition-fast)",
  },
  collapsedItemActive: {
    background: "var(--color-accent-light)",
    borderColor: "var(--color-accent)",
    color: "var(--color-accent)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 14px",
    borderBottom: "1px solid var(--color-border-light)",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
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
    gap: 2,
  },
  iconBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    background: "none",
    border: "none",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-muted)",
    cursor: "pointer",
    transition: "all var(--transition-fast)",
  },
  createRow: {
    padding: "10px 14px",
    borderBottom: "1px solid var(--color-border-light)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    animation: "fadeIn 0.2s ease",
  },
  createInputWrapper: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: "var(--color-surface-secondary)",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--color-accent)",
  },
  createInput: {
    flex: 1,
    background: "none",
    border: "none",
    color: "var(--color-text)",
    fontSize: 13,
    outline: "none",
  },
  createActions: {
    display: "flex",
    gap: 6,
  },
  createConfirmBtn: {
    flex: 1,
    padding: "6px 12px",
    background: "var(--color-accent)",
    border: "none",
    borderRadius: "var(--radius-sm)",
    color: "#fff",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  },
  createCancelBtn: {
    padding: "6px 12px",
    background: "none",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-text-secondary)",
    fontSize: 12,
    cursor: "pointer",
  },
  searchRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 14px",
    borderBottom: "1px solid var(--color-border-light)",
  },
  searchInput: {
    flex: 1,
    background: "none",
    border: "none",
    color: "var(--color-text)",
    fontSize: 12,
    outline: "none",
  },
  clearSearchBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    background: "none",
    border: "none",
    borderRadius: "50%",
    color: "var(--color-muted)",
    cursor: "pointer",
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
    textAlign: "center",
  },
  emptyAction: {
    padding: "6px 12px",
    background: "var(--color-accent-light)",
    border: "1px solid var(--color-accent)",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-accent)",
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
  },
  item: {
    padding: "10px 14px",
    cursor: "pointer",
    borderBottom: "1px solid var(--color-border-light)",
    transition: "all var(--transition-fast)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  itemActive: {
    background: "var(--color-accent-light)",
    borderLeft: "3px solid var(--color-accent)",
  },
  itemHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  itemAvatar: {
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--color-accent-light)",
    color: "var(--color-accent)",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    fontWeight: 600,
    flexShrink: 0,
  },
  itemContent: {
    flex: 1,
    minWidth: 0,
  },
  itemName: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--color-text)",
    marginBottom: 2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  itemMeta: {
    display: "flex",
    gap: 8,
    fontSize: 11,
    color: "var(--color-muted)",
    alignItems: "center",
  },
  metaItem: {
    display: "flex",
    alignItems: "center",
    gap: 3,
  },
  boundBadge: {
    display: "flex",
    alignItems: "center",
    gap: 3,
    padding: "1px 6px",
    background: "var(--color-success-light)",
    color: "var(--color-success)",
    borderRadius: "var(--radius-full)",
    fontSize: 10,
    fontWeight: 500,
  },
  permBadge: {
    padding: "1px 6px",
    background: "var(--color-surface-secondary)",
    borderRadius: "var(--radius-full)",
    fontSize: 10,
    color: "var(--color-text-secondary)",
  },
  bindBtn: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 10px",
    background: "var(--color-accent-light)",
    border: "1px solid transparent",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-accent)",
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
    alignSelf: "flex-start",
  },
};
