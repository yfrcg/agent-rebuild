import * as fs from "fs";
import * as path from "path";
import { globSync } from "glob";
import { getDb } from "../../storage/src/db";
import { resolveWorkspacePath } from "../../core/src/config";

type Chunk = {
  chunkId: string;
  filePath: string;
  section: string;
  content: string;
};

function splitIntoChunks(filePath: string, content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  let currentSection = "ROOT";
  let buffer: string[] = [];

  function flush() {
    const joined = buffer.join("\n").trim();
    if (!joined) return;

    chunks.push({
      chunkId: `${filePath}#${chunks.length}`,
      filePath,
      section: currentSection,
      content: joined,
    });

    buffer = [];
  }

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      currentSection = line.replace(/^## /, "").trim();
    } else {
      buffer.push(line);
    }
  }

  flush();
  return chunks;
}

export function rebuildMemoryIndex() {
  const db = getDb();

  db.exec(`DELETE FROM mem_docs;`);
  db.exec(`DELETE FROM mem_fts;`);

  const files = [
    resolveWorkspacePath("MEMORY.md"),
    ...globSync(path.join(resolveWorkspacePath("memory"), "*.md")),
  ].filter((p) => fs.existsSync(p));

  const insertDoc = db.prepare(`
    INSERT INTO mem_docs (chunkId, filePath, section, content)
    VALUES (@chunkId, @filePath, @section, @content)
  `);

  const insertFts = db.prepare(`
    INSERT INTO mem_fts (chunkId, filePath, section, content)
    VALUES (@chunkId, @filePath, @section, @content)
  `);

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    const chunks = splitIntoChunks(filePath, content);

    for (const chunk of chunks) {
      insertDoc.run(chunk);
      insertFts.run(chunk);
    }
  }
}