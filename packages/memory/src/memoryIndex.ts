/**
 * ?????CS336 ???
 * ???packages/memory/src/memoryIndex.ts
 * ??????????
 * ????????????FTS/?????????????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { globSync } from "glob";
import { getDb } from "../../storage/src/db";
import { resolveWorkspacePath } from "../../core/src/config";
import type { MemoryChunk } from "./types";
import { upsertFileRecord, markFtsReady, deleteFileChunks, getFileRecord } from "./fileManager";

/**
 * 单个 chunk 允许的最大字符数。
 *
 * 目的是在建索引前就控制文本块大小，避免后续 embedding 或提示词处理时超限。
 */
const MAX_CHUNK_CHARS = 4000;

/**
 * 计算文件内容哈希。
 *
 * 用哈希而不是 mtime 判断内容是否变化，可以规避“时间变了但内容没变”的误触发。
 */
function hashFile(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

/**
 * 把记忆文件切成多个 chunk。
 *
 * 分块策略基于二级标题：
 * - 遇到 `##` 认为进入一个新 section。
 * - 同时加上最大长度保护，避免单个 section 过长。
 */
function splitIntoChunks(filePath: string, content: string): MemoryChunk[] {
  const lines = content.split("\n");
  const chunks: MemoryChunk[] = [];

  const dateMatch = filePath.match(/memory\/(\d{4}-\d{2}-\d{2})\.md$/);
  const date = dateMatch ? dateMatch[1] : undefined;

  let currentSection = "ROOT";
  let buffer: string[] = [];
  let bufferChars = 0;

  /**
   * 函数 `shouldSkipChunk` 的职责说明。
   * `shouldSkipChunk` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  function shouldSkipChunk(section: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (/^#\s+.+$/.test(trimmed) && !trimmed.includes("\n")) return true;
    if (section === "ROOT" && trimmed.length < 30) return true;
    return false;
  }

  /**
   * 把当前缓冲区内容真正落成一个 chunk。
   *
   * 如果太短、只有标题或为空则跳过；
   * 如果太长则按段落裁掉前半部分，优先保留后半段内容。
   */
  function flush() {
    const joined = buffer.join("\n").trim();
    if (shouldSkipChunk(currentSection, joined)) {
      buffer = [];
      bufferChars = 0;
      return;
    }

    if (joined.length > MAX_CHUNK_CHARS) {
      const paragraphs = joined.split(/\n\n+/);
      const truncated = paragraphs.slice(-Math.ceil(paragraphs.length / 2));
      chunks.push({
        chunkId: `${filePath}#${chunks.length}`,
        file_id: "",
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
      file_id: "",
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

    if (bufferChars > MAX_CHUNK_CHARS) {
      flush();
    }
  }

  flush();
  return chunks;
}

/**
 * 增量更新单个文件的记忆索引。
 *
 * 这是整个记忆系统最关键的入口之一：
 * - 若文件内容没变，直接跳过。
 * - 若变了，则在事务中重建 docs / fts / embeddings 三套数据。
 */
export function upsertFileIndex(filePath: string) {
  const db = getDb();
  const content = fs.readFileSync(filePath, "utf8");
  const newHash = hashFile(content);

  const existing = getFileRecord(db, filePath);
  if (existing && existing.content_hash === newHash) {
    return;
  }

  const chunks = splitIntoChunks(filePath, content);

  db.exec("BEGIN TRANSACTION");
  try {
    const fileRecord = upsertFileRecord(db, filePath, newHash);
    const file_id = fileRecord.file_id;

    deleteFileChunks(db, file_id);

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
      insertDoc.run(params);
      insertFts.run(params);
      insertEmbedding.run({ ...params, embedding: null });
    }

    markFtsReady(db, file_id, chunks.length);

    // 只要 chunk 发生变化，旧向量就失效了，因此必须重置为 pending。
    db.prepare(`UPDATE mem_files SET embedding_status = 'pending' WHERE file_id = ?`).run(file_id);

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * 全量重建记忆索引。
 *
 * 这个函数会先清空所有索引表，再重新扫描 `MEMORY.md` 与 `memory/*.md`，
 * 适合做灾后重建、升级后重跑或排查索引一致性问题。
 */
export function rebuildMemoryIndex() {
  const db = getDb();

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
