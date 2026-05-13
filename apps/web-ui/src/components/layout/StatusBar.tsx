/**
 * ?????CS336 ???
 * ???apps/web-ui/src/components/layout/StatusBar.tsx
 * ???Web UI ?????
 * ?????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import { useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { useRunStore } from "../../stores/runStore";

const STATUS_COLORS: Record<string, string> = {
  ready: "var(--color-success)",
  connecting: "var(--color-warning)",
  authenticating: "var(--color-warning)",
  reconnecting: "var(--color-warning)",
  disconnected: "var(--color-error)",
};

const STATUS_LABELS: Record<string, string> = {
  ready: "Connected",
  connecting: "Connecting…",
  authenticating: "Authenticating…",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

export function StatusBar() {
  const state = useConnectionStore((s) => s.state);
  const reconnectCount = useConnectionStore((s) => s.reconnectCount);
  const lastHeartbeat = useConnectionStore((s) => s.lastHeartbeat);
  const lastError = useConnectionStore((s) => s.lastError);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const activeRunIds = useRunStore((s) => s.activeRunIds);
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div style={styles.bar}>
      <div style={styles.leftSection}>
        <div style={styles.logoArea}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
            <path d="M12 2L2 7l10 5 10-5-10-5z" fill="var(--color-accent)" opacity="0.8"/>
            <path d="M2 17l10 5 10-5" stroke="var(--color-accent)" strokeWidth="2" fill="none"/>
            <path d="M2 12l10 5 10-5" stroke="var(--color-accent)" strokeWidth="2" fill="none" opacity="0.6"/>
          </svg>
          <span style={styles.brandName}>Agent Gateway</span>
        </div>

        <div style={styles.divider} />

        <div style={styles.statusGroup}>
          <span
            style={{
              ...styles.statusDot,
              backgroundColor: STATUS_COLORS[state] ?? "var(--color-muted)",
              boxShadow: `0 0 0 3px ${STATUS_COLORS[state] ?? "var(--color-muted)"}22`,
            }}
          />
          <span style={{
            ...styles.statusLabel,
            color: state === "ready" ? "var(--color-success)" : "var(--color-text-secondary)",
          }}>
            {STATUS_LABELS[state] ?? state}
          </span>
        </div>

        {reconnectCount > 0 && (
          <span style={styles.reconnectBadge}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M1 4v6h6M23 20v-6h-6"/>
              <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
            </svg>
            {reconnectCount}
          </span>
        )}
      </div>

      <div style={styles.centerSection}>
        {capabilities && (
          <div style={styles.capabilityGroup}>
            {capabilities.sandbox && (
              <span style={styles.capBadge}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <path d="M9 3v18M3 9h18"/>
                </svg>
                Sandbox
              </span>
            )}
            {capabilities.tools && (
              <span style={styles.capBadge}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning)" strokeWidth="2">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                </svg>
                Tools
              </span>
            )}
            {capabilities.memory && (
              <span style={styles.capBadge}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2">
                  <path d="M12 2a10 10 0 1 0 10 10H12V2z"/>
                  <path d="M12 2a10 10 0 0 1 10 10"/>
                </svg>
                Memory
              </span>
            )}
          </div>
        )}
      </div>

      <div style={styles.rightSection}>
        {activeRunIds.length > 0 && (
          <span style={styles.runIndicator}>
            <span style={styles.runPulse} />
            {activeRunIds.length} running
          </span>
        )}

        {lastHeartbeat && (
          <span style={styles.heartbeat}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--color-success)" stroke="none">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
            {new Date(lastHeartbeat).toLocaleTimeString()}
          </span>
        )}

        {lastError && (
          <span style={styles.errorBadge} title={lastError}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {lastError}
          </span>
        )}

        <div style={styles.divider} />

        <button
          style={styles.iconBtn}
          title="Settings"
          onClick={() => setShowSettings(!showSettings)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>

        <button style={styles.iconBtn} title="Notifications">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
        </button>

        <button style={styles.iconBtn} title="Help">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px",
    background: "var(--color-surface)",
    borderBottom: "1px solid var(--color-border-light)",
    fontSize: 13,
    color: "var(--color-text-secondary)",
    flexShrink: 0,
    height: 48,
    overflow: "hidden",
    boxShadow: "var(--shadow-sm)",
    zIndex: 10,
  },
  leftSection: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexShrink: 0,
  },
  logoArea: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  brandName: {
    fontSize: 14,
    fontWeight: 700,
    color: "var(--color-text)",
    letterSpacing: "-0.01em",
  },
  divider: {
    width: 1,
    height: 20,
    background: "var(--color-border-light)",
  },
  statusGroup: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    display: "inline-block",
    transition: "background-color var(--transition-normal)",
  },
  statusLabel: {
    fontWeight: 500,
    fontSize: 12,
  },
  reconnectBadge: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 8px",
    background: "var(--color-warning-light)",
    color: "var(--color-warning)",
    borderRadius: "var(--radius-full)",
    fontSize: 11,
    fontWeight: 600,
  },
  centerSection: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
  },
  capabilityGroup: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  capBadge: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 10px",
    background: "var(--color-surface-secondary)",
    borderRadius: "var(--radius-full)",
    fontSize: 11,
    fontWeight: 500,
    color: "var(--color-text-secondary)",
  },
  rightSection: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  runIndicator: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    background: "var(--color-accent-light)",
    color: "var(--color-accent)",
    borderRadius: "var(--radius-full)",
    fontSize: 11,
    fontWeight: 600,
  },
  runPulse: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--color-accent)",
    animation: "pulse 1.5s ease-in-out infinite",
  },
  heartbeat: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    color: "var(--color-muted)",
  },
  errorBadge: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 10px",
    background: "var(--color-error-light)",
    color: "var(--color-error)",
    borderRadius: "var(--radius-full)",
    fontSize: 11,
    fontWeight: 500,
    maxWidth: 200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    cursor: "help",
  },
  iconBtn: {
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
    transition: "all var(--transition-fast)",
  },
};
