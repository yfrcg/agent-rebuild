
import { getDb } from "../storage/src/db";
import { getDirtyFtsFiles } from "../memory/src/fileManager";
import { upsertFileIndex } from "../memory/src/memoryIndex";
import { backfillEmbeddings } from "../memory/src/backfillEmbeddings";
import { archiveOldMemory } from "../memory/src/compactMemory";
import { migrateEmbeddingsToBlob } from "../memory/src/embeddingStore";

/**
 * Default interval for the background memory scheduler (5 minutes).
 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Background scheduler that maintains memory lifecycle:
 * 1. Rebuilds FTS index for dirty files
 * 2. Backfills pending embeddings
 * 3. Archives old daily memory files (>7 days)
 *
 * Runs as a background loop with graceful error handling per tick.
 * Call `start()` to begin, `stop()` to shut down.
 */
export class MemoryScheduler {
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private running = false;

  constructor(intervalMs = DEFAULT_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Run first tick after a short delay to not block startup
    setTimeout(() => this.tick(), 10_000);
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getTickCount(): number {
    return this.tickCount;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.tickCount++;

    const db = getDb();
    let actions = 0;

    // 0. Migrate legacy JSON embeddings to BLOB (one-time, on first tick)
    if (this.tickCount === 1) {
      try {
        const migrated = migrateEmbeddingsToBlob();
        if (migrated > 0) {
          console.log(`[memory-scheduler] migrated ${migrated} embeddings to BLOB format`);
          actions++;
        }
      } catch (e) {
        console.error("[memory-scheduler] BLOB migration failed:", e);
      }
    }

    // 1. Rebuild dirty FTS indexes
    try {
      const dirtyFiles = getDirtyFtsFiles(db);
      for (const file of dirtyFiles) {
        try {
          upsertFileIndex(file.path);
          actions++;
        } catch (e) {
          console.error(`[memory-scheduler] FTS index failed for ${file.path}:`, e);
        }
      }
    } catch (e) {
      console.error("[memory-scheduler] dirty FTS check failed:", e);
    }

    // 2. Backfill pending embeddings
    try {
      const pendingCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM mem_files WHERE embedding_status = 'pending'"
      ).get() as { cnt: number };

      if (pendingCount.cnt > 0) {
        const result = await backfillEmbeddings();
        if (result.updated > 0) {
          actions++;
        }
      }
    } catch (e) {
      console.error("[memory-scheduler] embedding backfill failed:", e);
    }

    // 3. Archive old daily memory
    try {
      const result = archiveOldMemory();
      if (result.count > 0) {
        console.log(`[memory-scheduler] archived ${result.count} old memory files`);
        actions++;
      }
    } catch (e) {
      console.error("[memory-scheduler] archive failed:", e);
    }

    if (actions > 0) {
      console.log(`[memory-scheduler] tick ${this.tickCount}: performed ${actions} actions`);
    }
  }
}
