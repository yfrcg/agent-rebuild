/**
 * ?????CS336 ???
 * ???apps/web-ui/src/components/layout/AppLayout.tsx
 * ???Web UI ?????
 * ?????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import { useState } from "react";
import type { PageId } from "../../App";
import { StatusBar } from "./StatusBar";
import { SessionSidebar } from "./SessionSidebar";
import { TimelinePanel } from "./TimelinePanel";

interface AppLayoutProps {
  pages: { id: PageId; label: string; icon: React.ReactNode }[];
  activePage: PageId;
  onPageChange: (page: PageId) => void;
  content: React.ReactNode;
}

export function AppLayout({
  pages,
  activePage,
  onPageChange,
  content,
}: AppLayoutProps) {
  const [timelineOpen, setTimelineOpen] = useState(true);

  return (
    <div style={styles.root}>
      <StatusBar />
      <div style={styles.body}>
        <SessionSidebar />
        <div style={styles.center}>
          <nav style={styles.tabs}>
            <div style={styles.tabsList}>
              {pages.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onPageChange(p.id)}
                  style={{
                    ...styles.tab,
                    ...(activePage === p.id ? styles.tabActive : {}),
                  }}
                >
                  <span style={styles.tabIcon}>{p.icon}</span>
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
            <div style={styles.tabsRight}>
              <button
                style={{
                  ...styles.toggleBtn,
                  ...(timelineOpen ? styles.toggleBtnActive : {}),
                }}
                onClick={() => setTimelineOpen(!timelineOpen)}
                title={timelineOpen ? "Hide events" : "Show events"}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                </svg>
              </button>
            </div>
          </nav>
          <div style={styles.contentArea}>{content}</div>
        </div>
        {timelineOpen && <TimelinePanel />}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    background: "var(--color-bg)",
  },
  body: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  center: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    overflow: "hidden",
  },
  tabs: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "var(--color-surface)",
    borderBottom: "1px solid var(--color-border-light)",
    padding: "0 8px",
    flexShrink: 0,
  },
  tabsList: {
    display: "flex",
    gap: 2,
  },
  tabsRight: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "10px 14px",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "var(--color-muted)",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: "var(--font-sans)",
    fontWeight: 500,
    transition: "all var(--transition-fast)",
    whiteSpace: "nowrap",
  },
  tabActive: {
    color: "var(--color-accent)",
    borderBottomColor: "var(--color-accent)",
    background: "var(--color-accent-light)",
  },
  tabIcon: {
    display: "flex",
    alignItems: "center",
  },
  toggleBtn: {
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
  toggleBtnActive: {
    background: "var(--color-accent-light)",
    color: "var(--color-accent)",
  },
  contentArea: {
    flex: 1,
    overflow: "auto",
    padding: 20,
  },
};
