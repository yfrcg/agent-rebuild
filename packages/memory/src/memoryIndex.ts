import * as fs from "fs";//用于读取记忆文件内容
import * as path from "path";//用于路径拼接
import * as crypto from "crypto";//用于计算内容 MD5 哈希
import { globSync } from "glob";//用于扫描 memory 目录下的所有 md 文件
import { getDb } from "../../storage/src/db";//获取数据库单例连接
import { resolveWorkspacePath } from "../../core/src/config";//解析 workspace 下的文件路径
import type { MemoryChunk } from "./types";//记忆切片类型定义
import { upsertFileRecord, markFtsReady, deleteFileChunks, getFileRecord } from "./fileManager";//文件级状态管理

//计算文件内容的 MD5 哈希（用于判断内容是否变化，从而决定是否需要重建索引）
function hashFile(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

//按 ## 二级标题切分记忆文件为 chunks，同时加入最大长度保护
//【安全】：单个 chunk 超过 MAX_CHUNK_CHARS 时强制切断，防止 Embedding API token 限制超限
const MAX_CHUNK_CHARS = 4000;//约 1500-2000 token，低于大多数 Embedding API 上限

function splitIntoChunks(filePath: string, content: string): MemoryChunk[] {
  const lines = content.split("\n");
  const chunks: MemoryChunk[] = [];

  //从文件名提取日期（如 memory/2026-04-20.md → "2026-04-20"），用于时间衰减排序
  const dateMatch = filePath.match(/memory\/(\d{4}-\d{2}-\d{2})\.md$/);
  const date = dateMatch ? dateMatch[1] : undefined;

  let currentSection = "ROOT";
  let buffer: string[] = [];
  let bufferChars = 0;//累计 buffer 的字符数，用于判断是否超过上限

  function shouldSkipChunk(section: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (/^#\s+.+$/.test(trimmed) && !trimmed.includes("\n")) return true;
    if (section === "ROOT" && trimmed.length < 30) return true;
    return false;
  }

  function flush() {
    const joined = buffer.join("\n").trim();
    if (shouldSkipChunk(currentSection, joined)) {
      buffer = [];
      bufferChars = 0;
      return;
    }

    //如果 joined 超过最大长度限制，按段落强制切割（从末尾向前截断）
    if (joined.length > MAX_CHUNK_CHARS) {
      const paragraphs = joined.split(/\n\n+/);//按双换行符分割段落
      const truncated = paragraphs.slice(-Math.ceil(paragraphs.length / 2));//保留后半部分
      chunks.push({
        chunkId: `${filePath}#${chunks.length}`,
        file_id: '',
        filePath,
        section: currentSection,
        content: truncated.join("\n\n"),
        date,
      });
      buffer = [];
      bufferChars = 0;
      return;
    }

    chunks.push({
      chunkId: `${filePath}#${chunks.length}`,
      file_id: '',
      filePath,
      section: currentSection,
      content: joined,
      date,
    });
    buffer = [];
    bufferChars = 0;
  }

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      currentSection = line.replace(/^## /, "").trim();
    } else {
      buffer.push(line);
      bufferChars += line.length + 1;
    }

    //即使不在 ## 边界，如果 buffer 累计过长也强制切
    if (bufferChars > MAX_CHUNK_CHARS) {
      flush();
    }
  }
  flush();
  return chunks;
}

//单文件增量 upsert: 先查旧 hash，hash 未变化则直接跳过
//【事务原子性】：upsertFileRecord 在事务内部执行，避免 hash 更新和 chunk 写入被拆分导致的不一致
//【embedding 重置】：无论新建还是更新，只要 chunks 有变化，embedding_status 必须重置为 pending
export function upsertFileIndex(filePath: string) {
  const db = getDb();
  const content = fs.readFileSync(filePath, "utf8");//读取文件最新内容
  const newHash = hashFile(content);//计算新内容的哈希

  //先查旧记录，判断 hash 是否变化，相同则短路返回（避免重复写入）
  const existing = getFileRecord(db, filePath);
  if (existing && existing.content_hash === newHash) {
    return;
  }

  //hash 不同（或新文件），执行 upsert
  const chunks = splitIntoChunks(filePath, content);//按 ## 标题 + 最大长度切分 chunks

  //开启事务：hash 更新、chunks 删除/插入、embedding_status 重置要么全成功，要么全回滚
  db.exec("BEGIN TRANSACTION");
  try {
    //upsertFileRecord 放在事务内部，确保 hash 和 chunks 同生共死
    const fileRecord = upsertFileRecord(db, filePath, newHash);
    const file_id = fileRecord.file_id;

    //先删该文件的旧 chunks（FTS + embeddings + docs）
    deleteFileChunks(db, file_id);

    //三张表一起写入：mem_docs（原始）、mem_fts（全文检索）、mem_embeddings（向量，待生成）
    const insertDoc = db.prepare(`
      INSERT INTO mem_docs (chunkId, file_id, filePath, section, content)
      VALUES (@chunkId, @file_id, @filePath, @section, @content)
    `);

    const insertFts = db.prepare(`
      INSERT INTO mem_fts (chunkId, file_id, filePath, section, content)
      VALUES (@chunkId, @file_id, @filePath, @section, @content)
    `);

    const insertEmbedding = db.prepare(`
      INSERT INTO mem_embeddings (chunkId, file_id, filePath, section, content, embedding)
      VALUES (@chunkId, @file_id, @filePath, @section, @content, @embedding)
    `);

    for (const chunk of chunks) {
      const params = { ...chunk, file_id };
      insertDoc.run(params);//写入原文档表
      insertFts.run(params);//写入 FTS 全文检索表（可立即用于关键词搜索）
      insertEmbedding.run({ ...params, embedding: null });//写入向量表（embedding 为 null，由 backfill 后台补）
    }

    markFtsReady(db, file_id, chunks.length);//FTS 同步完成，标记 ready
    //【关键修复】：无论新建还是更新，只要 chunks 变了，embedding_status 必须重置为 pending
    //因为旧向量已经和旧 chunks 一起被删了，新的 chunks 还没有向量
    db.prepare(`UPDATE mem_files SET embedding_status = 'pending' WHERE file_id = ?`).run(file_id);

    db.exec("COMMIT");//一切顺利，提交事务
  } catch (e) {
    db.exec("ROLLBACK");//任何一步出错，回滚全部操作
    throw e;
  }
}

//全量重建：清空所有表，重新索引全部文件
export function rebuildMemoryIndex() {
  const db = getDb();

  //大规模 DELETE 包裹在事务内，否则 SQLite 会为每条记录单独生成事务，极慢
  db.exec("BEGIN TRANSACTION");
  try {
    db.exec(`DELETE FROM mem_embeddings;`);
    db.exec(`DELETE FROM mem_fts;`);
    db.exec(`DELETE FROM mem_docs;`);
    db.exec(`DELETE FROM mem_files;`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const files = [
    resolveWorkspacePath("MEMORY.md"),
    ...globSync(path.join(resolveWorkspacePath("memory"), "*.md")),
  ].filter((p) => fs.existsSync(p));

  for (const filePath of files) {
    upsertFileIndex(filePath);
  }
}
