/**
 * ?????CS336 ???
 * ???apps/web-ui/src/stores/connectionStore.ts
 * ??????????
 * ??????? WebSocket ?????????????
 * ???????????????????????????????????? README ????????????????
 */
import { create } from "zustand";

export type ConnectionStateValue =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "ready"
  | "reconnecting";

interface ConnectionState {
  state: ConnectionStateValue;
  reconnectCount: number;
  lastError: string | null;
  lastHeartbeat: string | null;
  capabilities: Record<string, boolean> | null;
}

interface ConnectionActions {
  setState: (state: ConnectionStateValue) => void;
  setReconnectCount: (count: number) => void;
  setError: (error: string | null) => void;
  setHeartbeat: (time: string) => void;
  setCapabilities: (caps: Record<string, boolean> | null) => void;
  reset: () => void;
}

const initialState: ConnectionState = {
  state: "disconnected",
  reconnectCount: 0,
  lastError: null,
  lastHeartbeat: null,
  capabilities: null,
};

export const useConnectionStore = create<ConnectionState & ConnectionActions>(
  (set) => ({
    ...initialState,
    setState: (state) => set({ state }),
    setReconnectCount: (reconnectCount) => set({ reconnectCount }),
    setError: (lastError) => set({ lastError }),
    setHeartbeat: (lastHeartbeat) => set({ lastHeartbeat }),
    setCapabilities: (capabilities) => set({ capabilities }),
    reset: () => set(initialState),
  })
);
