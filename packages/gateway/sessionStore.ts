import * as fs from "node:fs";
import * as path from "node:path";

import { resolveWorkspacePath } from "../core/src/config";

import type {
  GatewaySession,
  GatewaySessionCreateInput,
  GatewaySessionId,
  GatewaySessionRenameInput,
  GatewaySessionStoreSnapshot,
} from "./sessionTypes";

const DEFAULT_SNAPSHOT_PATH = path.resolve(
  process.cwd(),
  "logs",
  "sessions",
  "sessions.json"
);

function nowIso(): string {
  return new Date().toISOString();
}

export class SessionStore {
  constructor(private readonly snapshotPath = DEFAULT_SNAPSHOT_PATH) {
    this.ensureSnapshotFile();
  }

  loadSessions(): GatewaySession[] {
    const snapshot = this.readSnapshot();
    return [...snapshot.sessions].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  saveSessions(sessions: GatewaySession[]): void {
    this.writeSnapshot({
      sessions,
    });
  }

  createSession(input?: GatewaySessionCreateInput): GatewaySession {
    const sessions = this.loadSessions();
    const timestamp = Date.now();
    const id = `session-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = nowIso();
    const session: GatewaySession = {
      id,
      name: input?.name?.trim() || `Session ${sessions.length + 1}`,
      createdAt,
      updatedAt: createdAt,
      messageCount: 0,
      transcriptPath: resolveWorkspacePath("sessions", `${id}.jsonl`),
    };

    sessions.push(session);
    this.saveSessions(sessions);

    return session;
  }

  listSessions(): GatewaySession[] {
    return this.loadSessions();
  }

  getSession(id: GatewaySessionId): GatewaySession | undefined {
    return this.loadSessions().find((session) => session.id === id);
  }

  renameSession(input: GatewaySessionRenameInput): GatewaySession | undefined {
    const sessions = this.loadSessions();
    const target = sessions.find((session) => session.id === input.id);

    if (!target) {
      return undefined;
    }

    target.name = input.name.trim();
    target.updatedAt = nowIso();
    this.saveSessions(sessions);
    return target;
  }

  touchSession(id: GatewaySessionId): GatewaySession | undefined {
    const sessions = this.loadSessions();
    const target = sessions.find((session) => session.id === id);

    if (!target) {
      return undefined;
    }

    target.updatedAt = nowIso();
    this.saveSessions(sessions);
    return target;
  }

  incrementMessageCount(
    id: GatewaySessionId,
    count = 1
  ): GatewaySession | undefined {
    const sessions = this.loadSessions();
    const target = sessions.find((session) => session.id === id);

    if (!target) {
      return undefined;
    }

    const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
    target.messageCount += safeCount;
    target.updatedAt = nowIso();
    this.saveSessions(sessions);
    return target;
  }

  private ensureSnapshotFile(): void {
    const dirPath = path.dirname(this.snapshotPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    if (!fs.existsSync(this.snapshotPath)) {
      this.writeSnapshot({ sessions: [] });
    }
  }

  private readSnapshot(): GatewaySessionStoreSnapshot {
    this.ensureSnapshotFile();
    const raw = fs.readFileSync(this.snapshotPath, "utf8").trim();

    if (!raw) {
      return { sessions: [] };
    }

    try {
      const parsed = JSON.parse(raw) as GatewaySessionStoreSnapshot;
      if (!Array.isArray(parsed.sessions)) {
        return { sessions: [] };
      }
      return parsed;
    } catch {
      return { sessions: [] };
    }
  }

  private writeSnapshot(snapshot: GatewaySessionStoreSnapshot): void {
    fs.writeFileSync(
      this.snapshotPath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8"
    );
  }
}
