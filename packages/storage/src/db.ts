import Database from "better-sqlite3";
import { ensureDir, resolveWorkspacePath } from "../../core/src/config";
//数据库建表语句
export function getDb() {
  ensureDir(resolveWorkspacePath("index"));
  const dbPath = resolveWorkspacePath("index", "memory.sqlite");
  const db = new Database(dbPath);
  //基础备份表mem_docs
  /*
  为什么需要这张表？
  FTS5 和向量表都只存 chunkId 引用，实际内容全靠 chunkId 关联到 mem_docs
  搜索时先通过 FTS/向量找到 chunkId，再从 mem_docs 取出完整 content 返回给用户
  相当于是"索引的索引"，保证单一数据源
  所以 mem_docs 是主表，FTS 和向量都是索引层，读写都围绕它展开。
  */
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_docs (
      chunkId TEXT PRIMARY KEY,
      filePath TEXT NOT NULL,
      section TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);
  //fts5表
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
      chunkId,
      filePath,
      section,
      content
    );
  `);
  //向量数据表
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_embeddings (
      chunkId TEXT PRIMARY KEY,
      filePath TEXT NOT NULL,
      section TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT
    );
  `);

  return db;
}