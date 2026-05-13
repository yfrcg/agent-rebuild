/**
 * ?????CS336 ???
 * ???apps/web-ui/src/stores/runStore.ts
 * ??????????
 * ??????? WebSocket ?????????????
 * ???????????????????????????????????? README ????????????????
 */
import { create } from "zustand";

export type RunPhase =
  | "idle"
  | "starting"
  | "running"
  | "streaming"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed";

interface RunState {
  phase: RunPhase;
  runId: string | null;
  sessionId: string | null;
  requestId: string | null;
  deltaBuffer: string;
  finalText: string;
  error: string | null;
  activeRunIds: string[];
}

interface RunActions {
  startRun: (runId: string, sessionId: string, requestId: string) => void;
  setPhase: (phase: RunPhase) => void;
  appendDelta: (text: string) => void;
  setCompleted: (text: string) => void;
  setFailed: (error: string) => void;
  setCancelled: () => void;
  reset: () => void;
}

const initialState: RunState = {
  phase: "idle",
  runId: null,
  sessionId: null,
  requestId: null,
  deltaBuffer: "",
  finalText: "",
  error: null,
  activeRunIds: [],
};

export const useRunStore = create<RunState & RunActions>((set) => ({
  ...initialState,
  startRun: (runId, sessionId, requestId) =>
    set((state) => ({
      phase: "starting",
      runId,
      sessionId,
      requestId,
      deltaBuffer: "",
      finalText: "",
      error: null,
      activeRunIds: [...state.activeRunIds, runId],
    })),
  setPhase: (phase) => set({ phase }),
  appendDelta: (text) =>
    set((state) => ({
      deltaBuffer: state.deltaBuffer + text,
      phase: state.phase === "starting" || state.phase === "running"
        ? "streaming"
        : state.phase,
    })),
  setCompleted: (text) =>
    set((state) => ({
      phase: "completed",
      finalText: text,
      deltaBuffer: "",
      activeRunIds: state.activeRunIds.filter((id) => id !== state.runId),
    })),
  setFailed: (error) =>
    set((state) => ({
      phase: "failed",
      error,
      activeRunIds: state.activeRunIds.filter((id) => id !== state.runId),
    })),
  setCancelled: () =>
    set((state) => ({
      phase: "cancelled",
      activeRunIds: state.activeRunIds.filter((id) => id !== state.runId),
    })),
  reset: () => set(initialState),
}));
