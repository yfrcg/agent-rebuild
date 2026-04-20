import Database from "better-sqlite3";
import { ensureDir, resolveWorkspacePath } from "../../core/src/config";

// 单例模式的数据库实例，初始化后不再改变
let _db: Database.Database | null = null;

/**
 * 获取或初始化 SQLite 数据库实例。
 * 采用单例模式，确保整个进程生命周期内只有一份数据库连接。
 * 首次调用时会创建 workspace/index/ 目录（如不存在），并初始化以下表结构：
 *
 * - mem_docs:      分块后的文档原始文本（用于 FTS 全文检索）
 * - mem_fts:       FTS5 虚拟表，提供高性能中文分词与全文搜索能力
 * - mem_embeddings: 向量嵌入表，存储每块文本的 embedding 数值
 * - mem_files:     文件元数据表，记录每个源文件的路径、哈希、时间戳及索引状态
 *
 * 数据库使用 WAL 模式以提升并发读写性能，并创建了 file_id 上的索引以加速关联查询。
 *
 * @returns Database.Database - 初始化好的 better-sqlite3 数据库实例
 */
export function getDb() {
  if (_db) return _db;

  // 确保 index 目录存在（数据库文件存放于此）
  ensureDir(resolveWorkspacePath("index"));

  // 数据库文件路径：workspace/index/memory.sqlite
  const dbPath = resolveWorkspacePath("index", "memory.sqlite");

  // 创建数据库连接
  _db = new Database(dbPath);

  // 启用 WAL（Write-Ahead Logging）模式：
  // 允许读写并发进行，写操作不会阻塞读操作，显著提升多线程/多会话场景下的性能
  _db.pragma("journal_mode = WAL");

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 表1：mem_docs — 文档分块存储表
  // 存储经过分块处理后的文档片段（chunk），每块包含：
  //   chunkId   - 分块唯一标识（主键），由文件哈希 + 块序号生成
  //   file_id    - 所属文件的唯一标识（关联 mem_files.file_id）
  //   filePath   - 原始文件路径（方便溯源）
  //   section    - 该块在文件内的位置/标题标识（如章节名）
  //   content    - 块的实际文本内容（FTS 索引的来源）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  _db.exec(`
    CREATE TABLE IF NOT EXISTS mem_docs (
      chunkId TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      filePath TEXT NOT NULL,
      section TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 表2：mem_fts — FTS5 全文搜索虚拟表
  // 通过 SQLite FTS5 插件实现高性能全文检索，支持中文分词（需配合 tokenizer）。
  // 实际数据存储在 mem_docs 表中，FTS 表只建立索引结构用于搜索加速。
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
      chunkId,
      file_id,
      filePath,
      section,
      content
    );
  `);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 表3：mem_embeddings — 向量嵌入存储表
  // 每条记录对应 mem_docs 中的一个 chunk，包含该块的语义向量。
  // embedding 字段存储为 JSON 字符串（JSON serialize 后的 number[]）。
  // 注意：若 embedding_status = 'pending'，则 embedding 字段可能为 NULL。
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 表4：mem_files — 文件元数据总表
  // 记录每个被索引的源文件的状态与属性，是整个索引系统的主入口。
  //
  // 状态字段说明（两个核心状态机）：
  //   fts_status        - 'dirty'(需要重建FTS索引) | 'indexed'(已索引) | 'error'(索引失败)
  //   embedding_status  - 'pending'(待生成向量) | 'done'(已完成) | 'error'(生成失败)
  //
  // 时间戳字段说明：
  //   fts_indexed_at       - 上次完成 FTS 索引的时间（ISO 字符串）
  //   embedding_indexed_at - 上次完成向量生成的时间（ISO 字符串）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

  // 为 chunkId 字段建立唯一索引（实际上 chunkId 已经是 PRIMARY KEY，
  // 此处索引主要用于加速 file_id 上的查询）
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON mem_docs(file_id);`);

  // 为 mem_embeddings 表的 file_id 字段建立索引，加速按文件批量查询嵌入向量
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_file_id ON mem_embeddings(file_id);`);

  return _db;
}