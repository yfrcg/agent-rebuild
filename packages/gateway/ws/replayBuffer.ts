import { getDb } from "../../storage/src/db";
import type { WsEvent } from "./protocol";

export interface ReplayEntry {
  seq: number;
  sessionId: string;
  event: string;
  payload: string;
  createdAt: string;
}

let ensuredDb: unknown = null;

function ensureTable(): void {
  const db = getDb();
  if (ensuredDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_replay_session_seq ON replay_buffer(session_id, seq);
  `);
  ensuredDb = db;
}

export function appendReplayEntry(entry: {
  sessionId: string;
  event: string;
  payload: unknown;
  createdAt: string;
}): ReplayEntry {
  ensureTable();
  const db = getDb();
  const maxSeq = db.prepare(
    `SELECT COALESCE(MAX(seq), 0) as max_seq FROM replay_buffer WHERE session_id = ?`
  ).get(entry.sessionId) as { max_seq: number };
  const seq = maxSeq.max_seq + 1;

  const payloadJson = entry.payload !== undefined ? JSON.stringify(entry.payload) : "{}";
  db.prepare(
    `INSERT INTO replay_buffer (seq, session_id, event, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(seq, entry.sessionId, entry.event, payloadJson, entry.createdAt);

  return {
    seq,
    sessionId: entry.sessionId,
    event: entry.event,
    payload: payloadJson,
    createdAt: entry.createdAt,
  };
}

export function getReplayEntries(sessionId: string, afterSeq = 0): ReplayEntry[] {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(
    `SELECT seq, session_id, event, payload_json, created_at
     FROM replay_buffer
     WHERE session_id = ? AND seq > ?
     ORDER BY seq ASC`
  ).all(sessionId, afterSeq) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    seq: row.seq as number,
    sessionId: row.session_id as string,
    event: row.event as string,
    payload: row.payload_json as string,
    createdAt: row.created_at as string,
  }));
}

export function getSessionReplaySize(sessionId: string): number {
  ensureTable();
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM replay_buffer WHERE session_id = ?`
  ).get(sessionId) as { count: number };
  return row.count;
}

export function pruneReplayBuffer(maxEntriesPerSession: number): number {
  ensureTable();
  const db = getDb();
  const sessions = db.prepare(
    `SELECT DISTINCT session_id FROM replay_buffer`
  ).all() as Array<{ session_id: string }>;

  let pruned = 0;
  for (const { session_id } of sessions) {
    const result = db.prepare(
      `DELETE FROM replay_buffer WHERE session_id = ? AND id NOT IN (
        SELECT id FROM replay_buffer WHERE session_id = ? ORDER BY seq DESC LIMIT ?
      )`
    ).run(session_id, session_id, maxEntriesPerSession);
    pruned += result.changes;
  }
  return pruned;
}

export function clearSessionReplay(sessionId: string): void {
  ensureTable();
  const db = getDb();
  db.prepare(`DELETE FROM replay_buffer WHERE session_id = ?`).run(sessionId);
}

export function clearAllReplay(): void {
  ensureTable();
  const db = getDb();
  db.prepare(`DELETE FROM replay_buffer`).run();
}

export class ReplayBuffer {
  private readonly maxEvents: number;
  private readonly clientBuffers = new Map<string, WsEvent[]>();

  constructor(options: { maxEvents?: number } = {}) {
    this.maxEvents = options.maxEvents ?? 1000;
    ensureTable();
  }

  appendSessionEvent(event: Omit<WsEvent, "seq">): WsEvent {
    const entry = appendReplayEntry({
      sessionId: event.sessionId ?? "",
      event: event.event,
      payload: event.payload,
      createdAt: event.createdAt,
    });

    return { ...event, seq: entry.seq };
  }

  appendClient(clientId: string, event: WsEvent): void {
    let buffer = this.clientBuffers.get(clientId);
    if (!buffer) {
      buffer = [];
      this.clientBuffers.set(clientId, buffer);
    }
    buffer.push(event);
    while (buffer.length > this.maxEvents) {
      buffer.shift();
    }
  }

  hasSessionHistory(sessionId: string): boolean {
    return getSessionReplaySize(sessionId) > 0;
  }

  getSessionSince(sessionId: string, lastSeq: number): WsEvent[] {
    const entries = getReplayEntries(sessionId, lastSeq);
    return entries.map((entry) => {
      let payload: unknown;
      try {
        payload = JSON.parse(entry.payload);
      } catch {
        payload = entry.payload;
      }
      return {
        type: "event" as const,
        seq: entry.seq,
        event: entry.event as WsEvent["event"],
        sessionId: entry.sessionId,
        payload,
        createdAt: entry.createdAt,
      };
    });
  }

  clear(clientId: string): void {
    this.clientBuffers.delete(clientId);
  }
}
