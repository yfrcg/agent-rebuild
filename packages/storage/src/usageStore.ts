import { getDb } from "./db";

export interface UsageRecord {
  id: string;
  sessionId?: string;
  requestId?: string;
  modelProvider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostCents: number;
  createdAt: string;
}

export interface SessionUsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostCents: number;
  requestCount: number;
}

const MODEL_COST_PER_1K_TOKENS: Record<string, { prompt: number; completion: number }> = {
  tokenplan: { prompt: 0.002, completion: 0.006 },
  minimax: { prompt: 0.002, completion: 0.006 },
};

let ensuredDb: unknown = null;

function ensureTable(): void {
  const db = getDb();
  if (ensuredDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      request_id TEXT,
      model_provider TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_cents REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at);
  `);
  ensuredDb = db;
}

export function recordUsage(record: UsageRecord): void {
  ensureTable();
  const db = getDb();
  db.prepare(
    `INSERT INTO usage_records (id, session_id, request_id, model_provider, prompt_tokens, completion_tokens, total_tokens, estimated_cost_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.sessionId ?? null,
    record.requestId ?? null,
    record.modelProvider,
    record.promptTokens,
    record.completionTokens,
    record.totalTokens,
    record.estimatedCostCents,
    record.createdAt
  );
}

export function getSessionUsage(sessionId: string): SessionUsageSummary {
  ensureTable();
  const db = getDb();
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(prompt_tokens), 0) as totalPromptTokens,
       COALESCE(SUM(completion_tokens), 0) as totalCompletionTokens,
       COALESCE(SUM(total_tokens), 0) as totalTokens,
       COALESCE(SUM(estimated_cost_cents), 0) as totalCostCents,
       COUNT(*) as requestCount
     FROM usage_records WHERE session_id = ?`
  ).get(sessionId) as SessionUsageSummary | undefined;
  return row ?? { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, totalCostCents: 0, requestCount: 0 };
}

export function getSessionRecords(sessionId: string, limit = 50): UsageRecord[] {
  ensureTable();
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, session_id, request_id, model_provider, prompt_tokens, completion_tokens, total_tokens, estimated_cost_cents, created_at
     FROM usage_records WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(sessionId, limit) as Array<Record<string, unknown>>;
  return rows.map(mapRowToRecord);
}

export function estimateCostCents(
  modelProvider: string,
  promptTokens: number,
  completionTokens: number
): number {
  const normalized = modelProvider.toLowerCase();
  const pricing = MODEL_COST_PER_1K_TOKENS[normalized];
  if (!pricing) return 0;
  const promptCost = (promptTokens / 1000) * pricing.prompt;
  const completionCost = (completionTokens / 1000) * pricing.completion;
  return Math.round((promptCost + completionCost) * 100);
}

function mapRowToRecord(row: Record<string, unknown>): UsageRecord {
  return {
    id: row.id as string,
    sessionId: (row.session_id as string) ?? undefined,
    requestId: (row.request_id as string) ?? undefined,
    modelProvider: row.model_provider as string,
    promptTokens: row.prompt_tokens as number,
    completionTokens: row.completion_tokens as number,
    totalTokens: row.total_tokens as number,
    estimatedCostCents: row.estimated_cost_cents as number,
    createdAt: row.created_at as string,
  };
}
