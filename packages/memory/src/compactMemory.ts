import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { globSync } from "glob";
import { resolveWorkspacePath, getDateString } from "../../core/src/config";
import { upsertFileIndex } from "./memoryIndex";
import { getDb } from "../../storage/src/db";
import { upsertFileRecord, getFileRecord } from "./fileManager";

/**
 * 归档保留天数。
 *
 * 超过该天数的 daily memory 文件会从“活跃记忆”转为“历史摘要”。
 */
const RETAIN_DAYS = 7;

/**
 * 计算文本内容的 MD5 哈希。
 *
 * 归档时仍需更新 mem_files 记录，因此要重新生成文件哈希。
 */
function hashFile(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

/**
 * 把超过保留期的 daily memory 归档到 `MEMORY.md`。
 *
 * 归档的核心思想是：
 * 1. 活跃索引不应该无限膨胀。
 * 2. 旧记忆也不应该直接丢失。
 * 所以这里把旧 daily 文件转换成历史摘要，并从活跃 FTS 索引中移除。
 */
export function archiveOldMemory() {
  const db = getDb() as any;
  const today = new Date();
  const memPath = resolveWorkspacePath("MEMORY.md");

  const files = globSync(path.join(resolveWorkspacePath("memory"), "*.md"));
  const archived: string[] = [];

  const memContent = fs.existsSync(memPath) ? fs.readFileSync(memPath, "utf8") : "";
  let memoryAppendData = "";

  for (const filePath of files) {
    const fileName = path.basename(filePath, ".md");
    const date = new Date(fileName);

    if (isNaN(date.getTime())) continue;

    const daysDiff = Math.floor((today.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (daysDiff <= RETAIN_DAYS) continue;

    const record = getFileRecord(db, filePath);
    if (record && String(record.fts_status) === "archived") continue;

    const summary = `## ${fileName}\n- 归档时间: ${getDateString()}, 保留 ${daysDiff} 天记忆摘要`;
    if (!memContent.includes(fileName) && !memoryAppendData.includes(fileName)) {
      memoryAppendData += `\n${summary}\n`;
    }

    const fileContent = fs.readFileSync(filePath, "utf8");
    const newHash = hashFile(fileContent);

    // 归档要么全成功，要么全回滚，避免出现文件状态和索引残留不一致。
    const archiveTransaction = db.transaction(() => {
      upsertFileRecord(db, filePath, newHash);
      db.prepare(`UPDATE mem_files SET fts_status = 'archived' WHERE path = ?`).run(filePath);

      db.prepare(`
        DELETE FROM mem_fts
        WHERE chunkId IN (
          SELECT chunkId FROM mem_docs WHERE filePath = ?
        )
      `).run(filePath);

      db.prepare(`DELETE FROM mem_docs WHERE filePath = ?`).run(filePath);
    });

    archiveTransaction();
    archived.push(fileName);
  }

  if (memoryAppendData.length > 0) {
    fs.appendFileSync(memPath, memoryAppendData, "utf8");
  }

  if (archived.length > 0) {
    upsertFileIndex(memPath);
  }

  return { archived, count: archived.length };
}
