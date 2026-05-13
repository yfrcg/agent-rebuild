/**
 * ?????CS336 ???
 * ???apps/web-ui/src/stores/approvalStore.ts
 * ??????????
 * ??????? WebSocket ?????????????
 * ???????????????????????????????????? README ????????????????
 */
import { create } from "zustand";

export interface ApprovalEntry {
  token: string;
  toolName: string;
  input: unknown;
  createdAt: string;
  expiresAt: string;
  message?: string;
  sessionId?: string;
}

interface ApprovalState {
  approvals: ApprovalEntry[];
  loading: boolean;
  error: string | null;
}

interface ApprovalActions {
  setApprovals: (approvals: ApprovalEntry[]) => void;
  addApproval: (approval: ApprovalEntry) => void;
  removeApproval: (token: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useApprovalStore = create<ApprovalState & ApprovalActions>(
  (set) => ({
    approvals: [],
    loading: false,
    error: null,
    setApprovals: (approvals) => set({ approvals }),
    addApproval: (approval) =>
      set((state) => ({
        approvals: [...state.approvals.filter((a) => a.token !== approval.token), approval],
      })),
    removeApproval: (token) =>
      set((state) => ({
        approvals: state.approvals.filter((a) => a.token !== token),
      })),
    setLoading: (loading) => set({ loading }),
    setError: (error) => set({ error }),
  })
);
