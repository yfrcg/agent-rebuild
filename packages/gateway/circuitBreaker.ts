import { getDb } from "../storage/src/db";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitCheckResult {
  allowed: boolean;
  state: CircuitState;
  retryAfterMs: number;
}

export interface GatewayCircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  breakerId?: string;
}

let ensuredDb: unknown = null;

function ensureTable(): void {
  const db = getDb();
  if (ensuredDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS circuit_breaker_state (
      breaker_id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'closed',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      opened_at INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  ensuredDb = db;
}

function loadState(breakerId: string): { state: CircuitState; consecutiveFailures: number; openedAt: number } | undefined {
  const db = getDb();
  const row = db.prepare(
    `SELECT state, consecutive_failures, opened_at FROM circuit_breaker_state WHERE breaker_id = ?`
  ).get(breakerId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    state: (row.state as CircuitState) ?? "closed",
    consecutiveFailures: (row.consecutive_failures as number) ?? 0,
    openedAt: (row.opened_at as number) ?? 0,
  };
}

function saveState(breakerId: string, state: CircuitState, consecutiveFailures: number, openedAt: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO circuit_breaker_state (breaker_id, state, consecutive_failures, opened_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(breaker_id) DO UPDATE SET
       state = excluded.state,
       consecutive_failures = excluded.consecutive_failures,
       opened_at = excluded.opened_at,
       updated_at = excluded.updated_at`
  ).run(breakerId, state, consecutiveFailures, openedAt, new Date().toISOString());
}

export class GatewayCircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly breakerId: string;

  constructor(private readonly options: GatewayCircuitBreakerOptions) {
    this.breakerId = options.breakerId ?? "default";
    ensureTable();
    const persisted = loadState(this.breakerId);
    if (persisted) {
      this.state = persisted.state;
      this.consecutiveFailures = persisted.consecutiveFailures;
      this.openedAt = persisted.openedAt;
    }
  }

  beforeRequest(now = Date.now()): CircuitCheckResult {
    if (this.state === "open") {
      const elapsed = now - this.openedAt;
      if (elapsed >= this.options.cooldownMs) {
        this.state = "half-open";
        this.persist();
        return {
          allowed: true,
          state: this.state,
          retryAfterMs: 0,
        };
      }

      return {
        allowed: false,
        state: this.state,
        retryAfterMs: Math.max(0, this.options.cooldownMs - elapsed),
      };
    }

    return {
      allowed: true,
      state: this.state,
      retryAfterMs: 0,
    };
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
    this.persist();
  }

  onFailure(now = Date.now()): void {
    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
    }
    this.persist();
  }

  getState(now = Date.now()): CircuitState {
    const probe = this.beforeRequest(now);
    return probe.state;
  }

  private persist(): void {
    try {
      saveState(this.breakerId, this.state, this.consecutiveFailures, this.openedAt);
    } catch {
      /* persist failure should not break request flow */
    }
  }
}
