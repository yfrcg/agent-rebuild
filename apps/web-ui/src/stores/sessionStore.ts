/**
 * ?????CS336 ???
 * ???apps/web-ui/src/stores/sessionStore.ts
 * ??????????
 * ??????? WebSocket ?????????????
 * ???????????????????????????????????? README ????????????????
 */
import { create } from "zustand";

export interface SessionEntry {
  id: string;
  name: string;
  messageCount: number;
  updatedAt: string;
  permission?: string;
  projectBound?: boolean;
  projectDir?: string | null;
  displayName?: string;
  activeSkills?: string[];
}

interface SessionState {
  sessions: SessionEntry[];
  currentSessionId: string | null;
}

interface SessionActions {
  setSessions: (sessions: SessionEntry[]) => void;
  setCurrentSession: (id: string | null) => void;
  updateSession: (id: string, updates: Partial<SessionEntry>) => void;
}

export const useSessionStore = create<SessionState & SessionActions>((set) => ({
  sessions: [],
  currentSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  setCurrentSession: (currentSessionId) => set({ currentSessionId }),
  updateSession: (id, updates) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      ),
    })),
}));
