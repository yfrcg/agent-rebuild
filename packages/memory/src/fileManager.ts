/**
 * ?????CS336 ???
 * ???packages/memory/src/fileManager.ts
 * ??????????
 * ????????????FTS/?????????????
 * ???????????????????????????????????? README ????????????????
 */


import * as fs from "fs";       // 文件操作：读取内容、获取 mtime
import * as crypto from "crypto"; // 加密：生成文件 UUID 和内容 MD5 哈希
import { resolveWorkspacePath } from "../../core/src/config"; // 解析 workspace 路径
import { getEmbedderKey } from "./embedder";
import type { MemoryChunk } from "./types"; // 内存切片的类型定义

/** 当前分块配置版本号，用于判断是否需要重新分块（分块规则变化时触发） */
const CHUNK_CONFIG_KEY = "default-v1";

/** 记忆来源类型：memory 为记忆文件，session 为会话记录 */
export type FileSource = "memory" | "session";

/** FTS 全文索引状态：dirty=需要重建，ready=已完成，error=失败 */
export type FtsStatus = "dirty" | "ready" | "error";

/** 向量索引状态：pending=待生成，ready=已完成，error=失败 */
export type EmbeddingStatus = "pending" | "ready" | "error";

/**
 * 文件记录表（mem_files）的类型定义。
 * 每条记录对应一个被纳入记忆管理的文件。
 */
export interface FileRecord {
  file_id: string;           // 文件的唯一标识符（UUID）
  path: string;              // 文件的绝对路径
  source: FileSource;        // 记忆来源
  content_hash: string;      // 文件内容的 MD5 哈希，用于判断是否变化
  mtime_ms: number;          // 文件修改时间（毫秒），用于辅助判断文件变化
  chunk_count: number;       // 该文件当前的分块数量
  chunk_config_key: string;  // 分块配置版本号，用于判断分块规则是否变化
  embedder_key: string | null; // embedding 模型版本号，null 表示从未生成过
  fts_status: FtsStatus;     // FTS 索引状态
  embedding_status: EmbeddingStatus; // 向量索引状态
  fts_indexed_at: string | null;    // FTS 最后索引时间（ISO 字符串）
  embedding_indexed_at: string | null; // 向量最后生成时间（ISO 字符串）
}

/** 数据库语句接口抽象（兼容 better-sqlite3） */
interface DbStmt {
  /** 方法 `run`：负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。 */
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  /** 方法 `get`：负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。 */
  get(...params: unknown[]): unknown;
  /** 方法 `all`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
  all(...params: unknown[]): unknown[];
}

/** 数据库连接接口抽象 */
interface DbConn {
  /** 方法 `exec`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
  exec(sql: string): void;
  /** 方法 `prepare`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
  prepare(sql: string): DbStmt;
}

/**
 * 计算文本内容的 MD5 哈希值。
 * 用于生成文件内容指纹，判断文件是否发生变化。
 *
 * @param content - 文件的文本内容
 * @returns 32位十六进制 MD5 哈希字符串
 */
function hashFile(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

/**
 * 获取指定文件的修改时间（毫秒精度）。
 *
 * @param filePath - 文件的绝对路径
 * @returns 文件的 mtimeMs（修改时间戳，毫秒）
 */
function getFileMtime(filePath: string): number {
  return fs.statSync(filePath).mtimeMs;
}

/**
 * 查询指定路径的文件记录。
 *
 * @param db - 数据库连接
 * @param filePath - 文件的绝对路径
 * @returns 文件记录对象，若不存在则返回 undefined
 */
export function getFileRecord(db: DbConn, filePath: string): FileRecord | undefined {
  return db.prepare("SELECT * FROM mem_files WHERE path = ?").get(filePath) as FileRecord | undefined;
}

/**
 * 插入或更新文件记录（upsert）。
 *
 * 【关键设计】：不再使用 INSERT ON CONFLICT DO UPDATE，因为该语句会 auto-commit，
 * 会破坏调用方事务的原子性。改为显式区分 INSERT 和 UPDATE 两个分支。
 *
 * 调用方需要在事务内调用本函数，由调用方控制事务边界。
 *
 * @param db - 数据库连接
 * @param filePath - 文件的绝对路径
 * @param newHash - 文件内容的 MD5 哈希
 * @param source - 记忆来源类型，默认为 "memory"
 * @returns 更新后的 FileRecord 对象
 */
export function upsertFileRecord(db: DbConn, filePath: string, newHash: string, source: FileSource = "memory"): FileRecord {
  const mtimeMs = getFileMtime(filePath);
  const existing = getFileRecord(db, filePath);
  const embedderKey = getEmbedderKey();
  // 已有文件沿用原 file_id，新文件生成新 UUID
  const file_id = existing?.file_id ?? crypto.randomUUID();

  if (existing) {
    // 文件已存在，执行 UPDATE：保留原有分块数量和索引状态（由索引完成后更新）
    db.prepare(`
      UPDATE mem_files
      SET content_hash = ?, mtime_ms = ?, chunk_count = ?, fts_status = ?, embedding_status = ?, fts_indexed_at = ?, embedding_indexed_at = ?
      WHERE file_id = ?
    `).run(
      newHash, mtimeMs,
      existing.chunk_count ?? 0,
      existing.fts_status ?? "dirty",      // 文件变化，标记 FTS 需要重建
      existing.embedding_status ?? "pending", // 文件变化，标记向量需要重新生成
      existing.fts_indexed_at ?? null,
      existing.embedding_indexed_at ?? null,
      file_id
    );
  } else {
    // 新文件，执行 INSERT：初始化所有状态
    db.prepare(`
      INSERT INTO mem_files (file_id, path, source, content_hash, mtime_ms, chunk_count, chunk_config_key, embedder_key, fts_status, embedding_status, fts_indexed_at, embedding_indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      file_id, filePath, source, newHash, mtimeMs,
      0, CHUNK_CONFIG_KEY, embedderKey,
      "dirty", "pending", null, null
    );
  }

  return {
    file_id, path: filePath, source,
    content_hash: newHash, mtime_ms: mtimeMs,
    chunk_count: existing?.chunk_count ?? 0,
    chunk_config_key: CHUNK_CONFIG_KEY, embedder_key: embedderKey,
    fts_status: existing?.fts_status ?? "dirty",
    embedding_status: existing?.embedding_status ?? "pending",
    fts_indexed_at: existing?.fts_indexed_at ?? null,
    embedding_indexed_at: existing?.embedding_indexed_at ?? null,
  };
}

/**
 * 检查文件内容是否发生变化。
 *
 * 通过比较新计算的 MD5 哈希与数据库中存储的旧哈希判断。
 * 文件不存在也视为"变化"（返回 true）。
 *
 * @param db - 数据库连接
 * @param filePath - 文件的绝对路径
 * @param newHash - 新计算的 MD5 哈希
 * @returns true 表示内容已变化，需要重新索引；false 表示无变化
 */
export function hasHashChanged(db: DbConn, filePath: string, newHash: string): boolean {
  const existing = getFileRecord(db, filePath);
  if (!existing) return true;
  return existing.content_hash !== newHash;
}

/**
 * 标记 FTS 全文索引已完成。
 * 在 FTS 索引构建成功后调用，更新分块数量和索引时间戳。
 *
 * @param db - 数据库连接
 * @param file_id - 文件的唯一标识
 * @param chunkCount - 该文件的实际分块数量
 */
export function markFtsReady(db: DbConn, file_id: string, chunkCount: number) {
  db.prepare(`
    UPDATE mem_files
    SET fts_status = 'ready', chunk_count = ?, fts_indexed_at = ?
    WHERE file_id = ?
  `).run(chunkCount, new Date().toISOString(), file_id);
}

/**
 * 标记 embedding 向量生成已完成。
 * 在所有 chunk 的向量都成功生成后调用。
 *
 * @param db - 数据库连接
 * @param file_id - 文件的唯一标识
 */
export function markEmbeddingReady(db: DbConn, file_id: string) {
  db.prepare(`
    UPDATE mem_files
    SET embedding_status = 'ready', embedding_indexed_at = ?
    WHERE file_id = ?
  `).run(new Date().toISOString(), file_id);
}

/**
 * 标记 embedding 向量生成失败。
 * 在网络错误、API 超时等异常情况下调用。
 *
 * @param db - 数据库连接
 * @param file_id - 文件的唯一标识
 */
export function markEmbeddingError(db: DbConn, file_id: string) {
  db.prepare(`UPDATE mem_files SET embedding_status = 'error' WHERE file_id = ?`).run(file_id);
}

/**
 * 查询所有需要生成 embedding 的文件（用于 backfill 调度）。
 * 筛选 embedding_status = 'pending' 的文件，即尚未生成向量的文件。
 *
 * @param db - 数据库连接
 * @returns 待生成向量的文件记录数组
 */
export function getPendingEmbeddingFiles(db: DbConn): FileRecord[] {
  return db.prepare("SELECT * FROM mem_files WHERE embedding_status = 'pending'").all() as FileRecord[];
}

/**
 * 查询所有需要重建 FTS 的文件（用于 scheduler 增量索引）。
 * 筛选 fts_status = 'dirty' 的文件，即内容变化后需要重新索引的文件。
 *
 * @param db - 数据库连接
 * @returns 待重建 FTS 的文件记录数组
 */
export function getDirtyFtsFiles(db: DbConn): FileRecord[] {
  return db.prepare("SELECT * FROM mem_files WHERE fts_status = 'dirty'").all() as FileRecord[];
}

/**
 * 删除某文件的所有 chunks 及关联的 FTS 向量数据和 embeddings。
 *
 * 删除顺序：mem_embeddings -> mem_fts -> mem_docs
 * - embeddings 存储在独立表，先删
 * - fts 是虚拟表（FTS5），必须显式删除
 * - docs 是主表，最后删
 *
 * 注意：本函数不控制事务，事务由调用方管理。
 *
 * @param db - 数据库连接
 * @param file_id - 文件的唯一标识
 */
export function deleteFileChunks(db: DbConn, file_id: string) {
  // 先查出该文件的所有 chunkId，避免直接关联删除导致子表记录遗漏
  const chunkIds = db.prepare("SELECT chunkId FROM mem_docs WHERE file_id = ?").all(file_id) as Array<{ chunkId: string }>;
  const ids = chunkIds.map((r) => r.chunkId);

  if (ids.length > 0) {
    // 动态生成 IN 子句的占位符（? 个数 = ids.length）
    const placeholders = ids.map(() => "?").join(",");

    // 删除向量数据（mem_embeddings）
    db.prepare(`DELETE FROM mem_embeddings WHERE chunkId IN (${placeholders})`).run(...ids);
    // 删除 FTS 全文索引数据（mem_fts，FTS5 虚拟表必须显式删除）
    db.prepare(`DELETE FROM mem_fts WHERE chunkId IN (${placeholders})`).run(...ids);
  }
  // 最后删除文档分块主数据（mem_docs）
  db.prepare(`DELETE FROM mem_docs WHERE file_id = ?`).run(file_id);
}
