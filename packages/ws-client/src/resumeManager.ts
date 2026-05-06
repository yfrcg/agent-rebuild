import type { WsEvent } from "./types";
import type { RequestManager } from "./requestManager";

export type ResyncHandler = () => Promise<void>;

export class ResumeManager {
  private readonly lastSeqBySession = new Map<string, number>();
  private readonly activeSessions = new Set<string>();
  private readonly resyncHandlers = new Set<ResyncHandler>();
  private readonly requestManager: RequestManager;
  private disposed = false;

  constructor(options: { requestManager: RequestManager }) {
    this.requestManager = options.requestManager;
  }

  trackEvent(event: WsEvent): void {
    if (!event.sessionId || event.seq <= 0) return;

    const current = this.lastSeqBySession.get(event.sessionId) ?? 0;
    if (event.seq > current) {
      this.lastSeqBySession.set(event.sessionId, event.seq);
    }
  }

  getLastSeq(sessionId: string): number {
    return this.lastSeqBySession.get(sessionId) ?? 0;
  }

  setActiveSessions(sessionIds: string[]): void {
    this.activeSessions.clear();
    for (const id of sessionIds) {
      this.activeSessions.add(id);
    }
  }

  addActiveSession(sessionId: string): void {
    this.activeSessions.add(sessionId);
  }

  removeActiveSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  getActiveSessions(): string[] {
    return Array.from(this.activeSessions);
  }

  buildResumeParams(): Array<{ sessionId: string; lastSeq: number }> {
    const params: Array<{ sessionId: string; lastSeq: number }> = [];

    for (const sessionId of this.activeSessions) {
      const lastSeq = this.lastSeqBySession.get(sessionId) ?? 0;
      if (lastSeq > 0) {
        params.push({ sessionId, lastSeq });
      }
    }

    return params;
  }

  onResyncRequired(handler: ResyncHandler): () => void {
    this.resyncHandlers.add(handler);
    return () => {
      this.resyncHandlers.delete(handler);
    };
  }

  async triggerResync(): Promise<void> {
    if (this.disposed) return;

    for (const handler of this.resyncHandlers) {
      try {
        await handler();
      } catch {
        // resync handler errors are non-fatal
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.lastSeqBySession.clear();
    this.activeSessions.clear();
    this.resyncHandlers.clear();
  }
}
