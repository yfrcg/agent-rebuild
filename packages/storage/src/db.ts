import Database from "better-sqlite3";
import { ensureDir, resolveWorkspacePath } from "../../core/src/config";

/**
 * 全局唯一的数据库实例。
 *
 * 项目采用单例连接模式，避免同一进程里反复创建 SQLite 连接，
 * 从而减少文件锁竞争和重复初始化开销。
 */
let _db: Database.Database | null = null;

/**
 * 获取或初始化 SQLite 数据库实例。
 *
 * 首次调用时会完成以下工作：
 * 1. 创建 `workspace/index/` 目录。
 * 2. 打开 `memory.sqlite` 数据库文件。
 * 3. 创建记忆系统所需的四张核心表。
 * 4. 打开 WAL 模式并建立必要索引。
 */
export function getDb() {
  if (_db) return _db;

  ensureDir(resolveWorkspacePath("index"));
  const dbPath = resolveWorkspacePath("index", "memory.sqlite");

  _db = new Database(dbPath);

  // WAL 允许读写并发，更适合当前这种频繁读写记忆和会话索引的场景。
  _db.pragma("journal_mode = WAL");

  /**
   * mem_docs：
   * 保存切分后的原始文本块，是全文检索和向量化的基础源数据。
   */
  _db.exec(`
    CREATE TABLE IF NOT EXISTS mem_docs (
      chunkId TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      filePath TEXT NOT NULL,
      section TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);

  /**
   * mem_fts：
   * 基于 FTS5 的全文检索虚拟表，用来做关键词检索加速。
   */
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
      chunkId,
      file_id,
      filePath,
      section,
      content
    );
  `);

  /**
   * mem_embeddings：
   * 保存每个 chunk 对应的向量数据，embedding 以 JSON 字符串形式落盘。
   */
  _db.exec(`
    CREATE TABLE IF NOT EXISTS mem_embeddings (
      chunkId TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      filePath TEXT NOT NULL,
      section TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT
    );
  `);

  /**
   * mem_files：
   * 文件级元数据总表，记录每个源文件的哈希、状态、分块数量和索引时间。
   */
  _db.exec(`
    CREATE TABLE IF NOT EXISTS mem_files (
      file_id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'memory',
      content_hash TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      chunk_config_key TEXT NOT NULL,
      embedder_key TEXT,
      fts_status TEXT NOT NULL DEFAULT 'dirty',
      embedding_status TEXT NOT NULL DEFAULT 'pending',
      fts_indexed_at TEXT,
      embedding_indexed_at TEXT
    );
  `);

  // 按 file_id 建索引，便于按文件成批查询 chunk 和 embedding。
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON mem_docs(file_id);`);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_file_id ON mem_embeddings(file_id);`);

  return _db;
}
