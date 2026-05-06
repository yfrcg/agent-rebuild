
import { getDb } from "../packages/storage/src/db";
import { getDirtyFtsFiles } from "../packages/memory/src/fileManager";
import { upsertFileIndex } from "../packages/memory/src/memoryIndex";
import { backfillEmbeddings } from "../packages/memory/src/backfillEmbeddings";
import { archiveOldMemory } from "../packages/memory/src/compactMemory";
import { globSync } from "glob";
import * as path from "path";
import * as fs from "fs";
import { resolveWorkspacePath } from "../packages/core/src/config";
import { compactTranscript } from "../packages/session/src/compact";

/**
 * 会话 transcript 触发压缩的行数阈值。
 */
const SESSION_TRANSCRIPT_THRESHOLD = 100;

/**
 * 调度器每轮检查的间隔时间。
 */
const CHECK_INTERVAL_MS = 30 * 1000;

/**
 * 执行一轮完整的后台调度。
 *
 * 当前包含四类任务：
 * 1. 重建 dirty 文件的 FTS 索引
 * 2. 回填 pending embedding
 * 3. 归档过期 daily memory
 * 4. 压缩过长 transcript
 */
async function tick() {
  const db = getDb();
  let actions = 0;

  const dirtyFiles = getDirtyFtsFiles(db);
  for (const file of dirtyFiles) {
    try {
      upsertFileIndex(file.path);
      actions += 1;
    } catch (e) {
      console.error(`[scheduler] FTS index failed for ${file.path}:`, e);
    }
  }

  const pendingFiles = db.prepare(
    "SELECT file_id, path FROM mem_files WHERE embedding_status = 'pending' LIMIT 3"
  ).all() as Array<{ file_id: string; path: string }>;

  if (pendingFiles.length > 0) {
    console.log(`[scheduler] processing ${pendingFiles.length} pending embedding files...`);
    try {
      const result = await backfillEmbeddings();
      console.log("[scheduler] backfill result:", result);
      actions += 1;
    } catch (e) {
      console.error("[scheduler] backfill failed:", e);
    }
  }

  try {
    const result = archiveOldMemory();
    if (result.count > 0) {
      console.log(`[scheduler] archived ${result.count} old memory files`);
      actions += 1;
    }
  } catch (e) {
    console.error("[scheduler] archive failed:", e);
  }

  try {
    const sessionsDir = resolveWorkspacePath("sessions");
    if (fs.existsSync(sessionsDir)) {
      const sessionFiles = globSync(path.join(sessionsDir, "*.jsonl"));

      for (const filePath of sessionFiles) {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n").filter(Boolean);

        if (lines.length > SESSION_TRANSCRIPT_THRESHOLD) {
          const sessionId = path.basename(filePath, ".jsonl");
          const result = compactTranscript(sessionId);
          if (result.flushed > 0) {
            console.log(
              `[scheduler] compacted session ${sessionId}: flushed ${result.flushed} to ${result.target}`
            );
            actions += 1;
          }
        }
      }
    }
  } catch (e) {
    console.error("[scheduler] session compaction failed:", e);
  }

  return actions;
}

/**
 * 启动无限循环调度器。
 *
 * 单次 tick 失败不会退出进程，
 * 这样后台维护任务能保持尽可能稳定地持续运行。
 */
async function main() {
  console.log(`[scheduler] started, checking every ${CHECK_INTERVAL_MS / 1000}s`);
  let tickCount = 0;

  while (true) {
    tickCount += 1;
    try {
      const actions = await tick();
      if (actions > 0) {
        console.log(`[scheduler] tick ${tickCount}: performed ${actions} actions`);
      }
    } catch (e) {
      console.error(`[scheduler] tick ${tickCount} error:`, e);
    }

    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error("[scheduler] fatal:", e);
  process.exit(1);
});
