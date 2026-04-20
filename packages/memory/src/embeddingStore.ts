import { getDb } from "../../storage/src/db";
import type { MemoryEmbeddingRecord } from "./types";

//从mem_embeddings中提取5个核心字段
export function getAllEmbeddingRecords(): MemoryEmbeddingRecord[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT chunkId, filePath, section, content, embedding
    FROM mem_embeddings
    ORDER BY filePath ASC, chunkId ASC
  `);

  const rows = stmt.all() as Array<{
    chunkId: string;
    filePath: string;
    section: string;
    content: string;
    embedding: string | null;
  }>;

  return rows.map((row) => ({
    chunkId: row.chunkId,
    filePath: row.filePath,
    section: row.section,
    content: row.content,
    embedding: row.embedding ? (JSON.parse(row.embedding) as number[]) : undefined,
  }));
}

//负责将LLM输出的向量数组更新到数据库里（已有记录，embedding 字段初始为 null）。
//使用的是 UPDATE 语句而不是 INSERT。这意味着，在生成向量之前，这些纯文本记忆的记录就已经被插入到数据库里了（可能是系统在读取 workspace 里的 Markdown 文件时就已经写入了数据库，只是当时 embedding 字段是空的）
export function saveEmbedding(chunkId: string, embedding: number[]) {
  const db = getDb();

  const stmt = db.prepare(`
    UPDATE mem_embeddings
    SET embedding = ?
    WHERE chunkId = ?
  `);

  stmt.run(JSON.stringify(embedding), chunkId);
}