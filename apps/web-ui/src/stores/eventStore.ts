/**
 * ?????CS336 ???
 * ???apps/web-ui/src/stores/eventStore.ts
 * ??????????
 * ??????? WebSocket ?????????????
 * ???????????????????????????????????? README ????????????????
 */
import { create } from "zustand";

export interface EventEntry {
  type: string;
  seq: number;
  event: string;
  runId?: string;
  sessionId?: string;
  payload?: unknown;
  createdAt: string;
}

interface EventFilter {
  sessionId?: string;
  runId?: string;
  eventType?: string;
}

interface EventState {
  events: EventEntry[];
  maxEvents: number;
  filter: EventFilter;
}

interface EventActions {
  addEvent: (event: EventEntry) => void;
  setFilter: (filter: EventFilter) => void;
  clearEvents: () => void;
}

const MAX_EVENTS = 500;

export const useEventStore = create<EventState & EventActions>((set) => ({
  events: [],
  maxEvents: MAX_EVENTS,
  filter: {},
  addEvent: (event) =>
    set((state) => ({
      events: [event, ...state.events].slice(0, state.maxEvents),
    })),
  setFilter: (filter) => set({ filter }),
  clearEvents: () => set({ events: [] }),
}));

export function selectFilteredEvents(state: EventState & EventActions): EventEntry[] {
  const { events, filter } = state;
  return events.filter((e) => {
    if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
    if (filter.runId && e.runId !== filter.runId) return false;
    if (filter.eventType && e.event !== filter.eventType) return false;
    return true;
  });
}
