export function createApprovalToken(): string {
  return `approve_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
