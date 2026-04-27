import { SessionStore } from "./sessionStore";
import type { GatewaySession, GatewaySessionId } from "./sessionTypes";

export class SessionManager {
  private currentSessionId: GatewaySessionId;

  constructor(private readonly sessionStore = new SessionStore()) {
    const sessions = this.sessionStore.listSessions();

    if (sessions.length === 0) {
      const initialSession = this.sessionStore.createSession({
        name: "Default Session",
      });
      this.currentSessionId = initialSession.id;
      return;
    }

    this.currentSessionId = sessions[0].id;
  }

  createSession(name?: string): GatewaySession {
    const session = this.sessionStore.createSession({ name });
    this.currentSessionId = session.id;
    return session;
  }

  listSessions(): GatewaySession[] {
    return this.sessionStore.listSessions();
  }

  getCurrentSession(): GatewaySession {
    const session = this.sessionStore.getSession(this.currentSessionId);
    if (!session) {
      const fallback = this.sessionStore.createSession({
        name: "Recovered Session",
      });
      this.currentSessionId = fallback.id;
      return fallback;
    }
    return session;
  }

  switchSession(id: GatewaySessionId): GatewaySession | undefined {
    const session = this.sessionStore.getSession(id);
    if (!session) {
      return undefined;
    }
    this.currentSessionId = session.id;
    this.sessionStore.touchSession(session.id);
    return this.sessionStore.getSession(session.id);
  }

  renameCurrentSession(name: string): GatewaySession {
    const renamed = this.sessionStore.renameSession({
      id: this.currentSessionId,
      name,
    });

    if (!renamed) {
      throw new Error("Current session not found.");
    }

    return renamed;
  }

  getCurrentSessionId(): GatewaySessionId {
    return this.currentSessionId;
  }

  touchCurrentSession(): GatewaySession {
    const touched = this.sessionStore.touchSession(this.currentSessionId);
    if (!touched) {
      throw new Error("Current session not found.");
    }
    return touched;
  }

  incrementCurrentSessionMessageCount(count = 1): GatewaySession {
    const updated = this.sessionStore.incrementMessageCount(
      this.currentSessionId,
      count
    );
    if (!updated) {
      throw new Error("Current session not found.");
    }
    return updated;
  }
}
