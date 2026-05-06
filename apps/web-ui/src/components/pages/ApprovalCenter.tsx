import { useState } from "react";
import { useGateway } from "../../providers/GatewayProvider";
import { useApprovalStore, type ApprovalEntry } from "../../stores/approvalStore";
import { GatewayError } from "@ws-client/types";

export function ApprovalCenter() {
  const approvals = useApprovalStore((s) => s.approvals);
  const removeApproval = useApprovalStore((s) => s.removeApproval);
  const [processing, setProcessing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = useGateway();

  const handleAction = async (
    approval: ApprovalEntry,
    action: "confirm" | "reject"
  ) => {
    setProcessing(approval.token + action);
    setError(null);
    try {
      if (action === "confirm") {
        await client.approvalConfirm(approval.sessionId ?? "", approval.token);
      } else {
        await client.approvalReject(approval.sessionId ?? "", approval.token);
      }
      removeApproval(approval.token);
    } catch (err) {
      if (err instanceof GatewayError) {
        setError(`[${err.code}] ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : "Action failed");
      }
    } finally {
      setProcessing(null);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.heading}>Approval Center</h2>
          <p style={styles.subheading}>
            Review and manage pending tool approval requests
          </p>
        </div>
        <span style={styles.countBadge}>
          {approvals.length} pending
        </span>
      </div>

      {error && (
        <div style={styles.globalError}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          {error}
        </div>
      )}

      {approvals.length === 0 ? (
        <div style={styles.empty}>
          <div style={styles.emptyIcon}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="1.5">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              <polyline points="9 12 12 15 16 10"/>
            </svg>
          </div>
          <span style={styles.emptyTitle}>No pending approvals</span>
          <span style={styles.emptyHint}>
            Tool approval requests will appear here when they require your confirmation
          </span>
        </div>
      ) : (
        <div style={styles.list}>
          {approvals.map((a) => {
            const isConfirming =
              processing === a.token + "confirm";
            const isRejecting =
              processing === a.token + "reject";
            const isBusy = isConfirming || isRejecting;
            return (
              <div key={a.token} style={styles.card}>
                <div style={styles.cardHeader}>
                  <div style={styles.toolBadge}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                    </svg>
                    {a.toolName}
                  </div>
                  {a.createdAt && (
                    <span style={styles.time}>
                      {new Date(a.createdAt).toLocaleTimeString()}
                    </span>
                  )}
                </div>

                <div style={styles.detailRow}>
                  <span style={styles.detailLabel}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    Approval Token
                  </span>
                  <span style={styles.detailValue}>{a.token}</span>
                </div>

                <div style={styles.detailRow}>
                  <span style={styles.detailLabel}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    Session
                  </span>
                  <span style={styles.detailValue}>{a.sessionId}</span>
                </div>

                {a.input !== undefined && a.input !== null && (
                  <div style={styles.inputSection}>
                    <span style={styles.inputLabel}>Input Parameters</span>
                    <pre style={styles.pre}>
                      {JSON.stringify(a.input, null, 2)}
                    </pre>
                  </div>
                )}

                {a.expiresAt && (
                  <div style={styles.detailRow}>
                    <span style={styles.detailLabel}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <circle cx="12" cy="12" r="10"/>
                        <polyline points="12 6 12 12 16 14"/>
                      </svg>
                      Expires
                    </span>
                    <span style={styles.detailValue}>
                      {new Date(a.expiresAt).toLocaleTimeString()}
                    </span>
                  </div>
                )}

                <div style={styles.actions}>
                  <button
                    style={{
                      ...styles.approveBtn,
                      opacity: isBusy ? 0.5 : 1,
                    }}
                    onClick={() => handleAction(a, "confirm")}
                    disabled={isBusy}
                  >
                    {isConfirming ? (
                      <span style={styles.spinner} />
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                    {isConfirming ? "Confirming…" : "Confirm"}
                  </button>
                  <button
                    style={{
                      ...styles.rejectBtn,
                      opacity: isBusy ? 0.5 : 1,
                    }}
                    onClick={() => handleAction(a, "reject")}
                    disabled={isBusy}
                  >
                    {isRejecting ? (
                      <span style={styles.spinnerLight} />
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    )}
                    {isRejecting ? "Rejecting…" : "Reject"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 760,
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
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
  countBadge: {
    padding: "4px 12px",
    background: "var(--color-warning-light)",
    color: "var(--color-warning)",
    borderRadius: "var(--radius-full)",
    fontSize: 12,
    fontWeight: 600,
  },
  globalError: {
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
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    padding: "48px 24px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-lg)",
    textAlign: "center",
    boxShadow: "var(--shadow-sm)",
  },
  emptyIcon: {
    width: 64,
    height: 64,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--color-success-light)",
    borderRadius: "var(--radius-xl)",
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: "var(--color-text)",
  },
  emptyHint: {
    fontSize: 13,
    color: "var(--color-muted)",
    lineHeight: 1.5,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  card: {
    padding: "16px 18px",
    background: "var(--color-surface)",
    border: "1px solid var(--color-border-light)",
    borderRadius: "var(--radius-lg)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    boxShadow: "var(--shadow-sm)",
    animation: "slideUp 0.2s ease",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toolBadge: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 12px",
    background: "var(--color-accent-light)",
    color: "var(--color-accent)",
    borderRadius: "var(--radius-full)",
    fontSize: 12,
    fontWeight: 600,
  },
  time: {
    fontSize: 11,
    color: "var(--color-muted)",
  },
  detailRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "4px 0",
    fontSize: 12,
  },
  detailLabel: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    color: "var(--color-text-secondary)",
  },
  detailValue: {
    color: "var(--color-text)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
  },
  inputSection: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  inputLabel: {
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
    maxHeight: 120,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    fontFamily: "var(--font-mono)",
    lineHeight: 1.5,
  },
  actions: {
    display: "flex",
    gap: 8,
    marginTop: 4,
  },
  approveBtn: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "10px 16px",
    background: "var(--color-success)",
    border: "none",
    borderRadius: "var(--radius-md)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    transition: "all var(--transition-fast)",
  },
  rejectBtn: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "10px 16px",
    background: "var(--color-error)",
    border: "none",
    borderRadius: "var(--radius-md)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    transition: "all var(--transition-fast)",
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
