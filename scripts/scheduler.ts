// 导入所有必要的模块
import { getDb } from "../packages/storage/src/db";              // SQLite 数据库实例
import { getDirtyFtsFiles } from "../packages/memory/src/fileManager";   // 获取需要重建 FTS 索引的文件
import { upsertFileIndex } from "../packages/memory/src/memoryIndex";     // 执行 FTS 索引更新
import { backfillEmbeddings } from "../packages/memory/src/backfillEmbeddings"; // 批量生成向量嵌入
import { archiveOldMemory } from "../packages/memory/src/compactMemory"; // 归档旧 memory 文件
import { globSync } from "glob";        // glob 模式匹配文件
import * as path from "path";
import * as fs from "fs";
import { resolveWorkspacePath } from "../packages/core/src/config"; // workspace 路径解析
import { compactTranscript } from "../packages/session/src/compact"; // 会话记录压缩

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 常量配置
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 会话 transcript 的压缩阈值。
 * 当单个会话的 JSONL 消息行数超过此值时，触发压缩逻辑。
 * 设为 100 条，约等于 50 轮对话（每轮含 user + assistant 两条消息）。
 */
const SESSION_TRANSCRIPT_THRESHOLD = 100;

/**
 * 调度器主循环的检查间隔（毫秒）。
 * 每隔 30 秒执行一次完整的检查任务。
 * 太短会增加系统负载，太长会导致任务响应不及时。
 */
const CHECK_INTERVAL_MS = 30 * 1000;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 核心逻辑：单次 tick（一个检查周期）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 执行一次完整的调度检查。
 *
 * 调度器按以下顺序执行四项任务（每一项都有独立的错误处理，任意一项失败不会阻断其他项）：
 *
 * 1. FTS 索引重建
 *    - 从数据库查询 fts_status = 'dirty' 的文件（通常是刚写入的 memory 文件）
 *    - 对每个文件调用 upsertFileIndex() 重建 FTS 索引
 *    - 这是实现全文搜索能力的关键步骤
 *
 * 2. 向量嵌入回填（后台执行，限流）
 *    - 从数据库查询 embedding_status = 'pending' 的文件，每次最多处理 3 个
 *    - 调用 backfillEmbeddings() 批量生成嵌入向量并写入向量数据库
 *    - 限流目的是避免短期内向 API 服务（如 DashScope）发送过多请求
 *
 * 3. 旧 memory 归档
 *    - 调用 archiveOldMemory() 识别并归档过期的 memory 文件
 *    - 每天执行一次即可（通过文件 mtime 做粗略判断）
 *
 * 4. 会话 transcript 压缩
 *    - 扫描 sessions/ 目录下所有 .jsonl 文件
 *    - 对消息行数超过 SESSION_TRANSCRIPT_THRESHOLD 的会话调用 compactTranscript()
 *    - 将旧消息根据关键词分流到 MEMORY.md 或当日日志
 *
 * @returns number - 本次 tick 实际执行的操作数（用于日志记录）
 */
async function tick() {
  const db = getDb();
  let actions = 0; // 累计执行的原子操作数

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 任务 1：处理 dirty FTS 文件
  // （通常是新写入的 memory 文件尚未建立全文索引）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const dirtyFiles = getDirtyFtsFiles(db);
  for (const file of dirtyFiles) {
    try {
      upsertFileIndex(file.path); // 重建该文件的 FTS 索引
      actions += 1;
    } catch (e) {
      // 单文件失败不影响其他文件，吞下异常避免阻断后续任务
      console.error(`[scheduler] FTS index failed for ${file.path}:`, e);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 任务 2：后台 embedding 生成（pending 文件的回填）
  // 限制每次最多处理 3 个文件，避免 API 调用过于集中
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const pendingFiles = db.prepare(
    "SELECT file_id, path FROM mem_files WHERE embedding_status = 'pending' LIMIT 3"
  ).all() as Array<{ file_id: string; path: string }>;

  if (pendingFiles.length > 0) {
    console.log(`[scheduler] processing ${pendingFiles.length} pending embedding files...`);
    try {
      const result = await backfillEmbeddings();
      console.log(`[scheduler] backfill result:`, result);
      actions += 1; // backfillEmbeddings 是一个批量操作，计为 1 次 action
    } catch (e) {
      console.error(`[scheduler] backfill failed:`, e);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 任务 3：旧 memory 归档（每天一次即可，用文件 mtime 做粗略判断）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  try {
    const result = archiveOldMemory();
    if (result.count > 0) {
      console.log(`[scheduler] archived ${result.count} old memory files`);
      actions += 1;
    }
  } catch (e) {
    console.error(`[scheduler] archive failed:`, e);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 任务 4：检查所有 session transcript 长度，超阈值则压缩
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  try {
    const sessionsDir = resolveWorkspacePath("sessions");
    if (fs.existsSync(sessionsDir)) {
      // 扫描 sessions/ 目录下所有 .jsonl 文件
      const sessionFiles = globSync(path.join(sessionsDir, "*.jsonl"));

      for (const filePath of sessionFiles) {
        // 读取文件内容，统计消息行数（每行一条 JSON 消息）
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n").filter(Boolean); // 过滤空行

        // 若超过阈值，触发压缩
        if (lines.length > SESSION_TRANSCRIPT_THRESHOLD) {
          // 从文件路径提取 sessionId：/path/to/sessions/{sessionId}.jsonl → sessionId
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
    console.error(`[scheduler] session compaction failed:`, e);
  }

  return actions;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 主入口：无限循环调度器
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 调度器主函数。
 * 以无限循环模式运行，每隔 CHECK_INTERVAL_MS 毫秒执行一次 tick()。
 * 所有异常均在循环内捕获，不会导致进程退出。
 * 日志输出格式：[scheduler] 前缀便于日志过滤与问题定位。
 */
async function main() {
  console.log(`[scheduler] started, checking every ${CHECK_INTERVAL_MS / 1000}s`);
  let tickCount = 0;

  while (true) {
    tickCount += 1;
    try {
      const actions = await tick();
      if (actions > 0) {
        // 只有在执行了实际操作时才打印日志，减少噪音
        console.log(`[scheduler] tick ${tickCount}: performed ${actions} actions`);
      }
    } catch (e) {
      // 单次 tick 异常不影响整体调度，打印错误后继续
      console.error(`[scheduler] tick ${tickCount} error:`, e);
    }

    // 等待下一个检查周期
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

// 启动调度器，若发生未捕获的致命错误则打印错误信息并以非零状态码退出
main().catch((e) => {
  console.error("[scheduler] fatal:", e);
  process.exit(1);
});