import { getDb } from "../../storage/src/db";

export type IdempotencyStatus = "running" | "completed" | "failed";

export interface IdempotencyRecord {
  key: string;
  method: string;
  status: IdempotencyStatus;
  createdAt: number;
  updatedAt: number;
  payload?: unknown;
  error?: unknown;
}

let ensuredDb: unknown = null;

function ensureTable(): void {
  const db = getDb();
  if (ensuredDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_records (
      key TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT,
      error_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_idem_updated ON idempotency_records(updated_at);
  `);
  ensuredDb = db;
}

export class IdempotencyStore {
  private readonly ttlMs: number;

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? 10 * 60_000;
    ensureTable();
  }

  get(key: string): IdempotencyRecord | undefined {
    this.cleanup();
    const db = getDb();
    const row = db.prepare(
      `SELECT key, method, status, created_at, updated_at, payload_json, error_json FROM idempotency_records WHERE key = ?`
    ).get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return mapRow(row);
  }

  list(): IdempotencyRecord[] {
    this.cleanup();
    const db = getDb();
    const rows = db.prepare(
      `SELECT key, method, status, created_at, updated_at, payload_json, error_json FROM idempotency_records ORDER BY updated_at DESC`
    ).all() as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  begin(key: string, method: string, payload?: unknown): IdempotencyRecord {
    this.cleanup();
    const existing = this.get(key);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const db = getDb();
    db.prepare(
      `INSERT INTO idempotency_records (key, method, status, created_at, updated_at, payload_json) VALUES (?, ?, 'running', ?, ?, ?)`
    ).run(key, method, now, now, payload !== undefined ? JSON.stringify(payload) : null);

    return { key, method, status: "running", createdAt: now, updatedAt: now, payload, error: undefined };
  }

  complete(key: string, payload: unknown): void {
    const now = Date.now();
    const db = getDb();
    db.prepare(
      `UPDATE idempotency_records SET status = 'completed', payload_json = ?, error_json = NULL, updated_at = ? WHERE key = ?`
    ).run(JSON.stringify(payload), now, key);
  }

  fail(key: string, error: unknown): void {
    const now = Date.now();
    const db = getDb();
    db.prepare(
      `UPDATE idempotency_records SET status = 'failed', error_json = ?, updated_at = ? WHERE key = ?`
    ).run(JSON.stringify(error), now, key);
  }

  cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.ttlMs;
    const db = getDb();
    db.prepare(`DELETE FROM idempotency_records WHERE updated_at < ?`).run(cutoff);
  }
}

function mapRow(row: Record<string, unknown>): IdempotencyRecord {
  return {
    key: row.key as string,
    method: row.method as string,
    status: row.status as IdempotencyStatus,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    payload: row.payload_json ? JSON.parse(row.payload_json as string) : undefined,
    error: row.error_json ? JSON.parse(row.error_json as string) : undefined,
  };
}
