import * as fs from "fs";//用于检查文件存在性和读取 MEMORY.md 内容
import * as path from "path";//用于解析文件名和路径
import * as crypto from "crypto";//用于生成文件内容 MD5 哈希
import { globSync } from "glob";//用于扫描 memory 目录下的所有 .md 文件
import { resolveWorkspacePath, getDateString } from "../../core/src/config";//用于解析 workspace 路径和获取当前日期字符串
import { upsertFileIndex } from "./memoryIndex";//用于归档后更新 MEMORY.md 的 FTS 索引
import { getDb } from "../../storage/src/db";//用于数据库操作（事务、文件状态更新、chunks 删除）
import { upsertFileRecord, getFileRecord } from "./fileManager";//用于查询文件记录和写入文件状态

//超过 RETAIN_DAYS 天的 daily memory 才会被归档（这里的"天"是指距今天数，不是写入日期）
const RETAIN_DAYS = 7;

function hashFile(content: string): string {//计算文本内容的 MD5 哈希
  return crypto.createHash("md5").update(content).digest("hex");
}

//将超过保留期限的 daily memory 归档到 MEMORY.md 的历史日志中
//归档后的文件从活跃索引中移除（FTS/docs 删，embedding 保留用于历史语义检索）
export function archiveOldMemory() {
  const db = getDb() as any;//transaction 是 better-sqlite3 的实例方法，不在当前类型声明里，强制 any
  const today = new Date();
  const memPath = resolveWorkspacePath("MEMORY.md");

  //一次性扫描 memory 目录下所有 .md 文件
  const files = globSync(path.join(resolveWorkspacePath("memory"), "*.md"));
  const archived: string[] = [];

  //提前读取 MEMORY.md 现有内容，避免在循环内每次都读文件（减少 I/O）
  const memContent = fs.existsSync(memPath) ? fs.readFileSync(memPath, "utf8") : "";
  //存放本次归档要追加到 MEMORY.md 的所有摘要，避免多次写盘
  let memoryAppendData = "";

  for (const filePath of files) {
    const fileName = path.basename(filePath, ".md");
    const date = new Date(fileName);

    //跳过无法解析日期的文件名（不是 daily memory 格式）
    if (isNaN(date.getTime())) continue;

    //计算文件日期距今天数，超过 RETAIN_DAYS 才归档
    const daysDiff = Math.floor((today.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (daysDiff <= RETAIN_DAYS) continue;

    //已经归档过的文件跳过（避免重复处理）
    const record = getFileRecord(db, filePath);
    //fts_status 可能为 archived，用 string 比较避免类型窄化问题
    if (record && String(record.fts_status) === "archived") continue;

    //生成该文件的归档摘要（只保留文件名和日期，不保留完整内容）
    const summary = `## ${fileName}\n- 归档时间: ${getDateString()}, 保留 ${daysDiff} 天记忆摘要`;
    //检查 MEMORY.md 原内容和本次批次中是否已有该记录，防止重复追加
    if (!memContent.includes(fileName) && !memoryAppendData.includes(fileName)) {
      memoryAppendData += `\n${summary}\n`;
    }

    //读取文件内容计算新哈希，用于更新 mem_files 记录（必须在事务外先算好）
    const fileContent = fs.readFileSync(filePath, "utf8");
    const newHash = hashFile(fileContent);

    //使用事务包裹：文件状态更新、chunks 删除要么全成功，要么全回滚
    const archiveTransaction = db.transaction(() => {
      //upsertFileRecord 在事务内执行，确保 hash 更新和 chunks 删除同生共死
      upsertFileRecord(db, filePath, newHash);
      //将该文件标记为 archived 状态（不再参与活跃 FTS 检索）
      db.prepare(`UPDATE mem_files SET fts_status = 'archived' WHERE path = ?`).run(filePath);

      //通过子查询删 FTS，避免 SQLite IN(?) 子句参数数量超限（? 数量有限制）
      db.prepare(`
        DELETE FROM mem_fts
        WHERE chunkId IN (
          SELECT chunkId FROM mem_docs WHERE filePath = ?
        )
      `).run(filePath);

      //删除该文件的原始文本 chunks（FTS 和 doc 删了，向量暂时保留）
      db.prepare(`DELETE FROM mem_docs WHERE filePath = ?`).run(filePath);
    });

    archiveTransaction();//执行事务
    archived.push(fileName);
  }

  //循环结束后，一次性将所有摘要追加到 MEMORY.md（减少写盘次数）
  if (memoryAppendData.length > 0) {
    fs.appendFileSync(memPath, memoryAppendData, "utf8");
  }

  //如果有文件归档，MEMORY.md 内容变了，需要更新它的 FTS 索引
  if (archived.length > 0) {
    upsertFileIndex(memPath);
  }

  return { archived, count: archived.length };
}
