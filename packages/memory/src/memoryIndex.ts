import * as fs from "fs";
import * as path from "path";
import { globSync } from "glob";
import { getDb } from "../../storage/src/db";
import { resolveWorkspacePath } from "../../core/src/config";
/*
它的主要任务是：把本地写的 Markdown 格式的记忆文件，切分成一小块一小块的“记忆片段”，然后存进 SQLite 数据库中，供 AI 以后进行全文搜索（Full-Text Search, 简称 FTS）。
这在 AI 领域被称为 RAG（检索增强生成）的基础前置数据处理流程。
*/
type Chunk = {
  chunkId: string;//片段的唯一ID
  filePath: string;//这个片段来自哪个文件
  section: string;//这个片段来自哪个小节
  content: string;//这个片段的具体文本内容
};

/*
工作原理：

它按行 (\n) 遍历整个 Markdown 文件的内容。

以二级标题（## ）作为切分边界。只要代码扫描到以 ##  开头的行，就会触发 flush() 闭包函数。

flush() 的作用：把刚才攒在一个缓存区 (buffer) 里的所有文本拼凑起来，打包成一个 Chunk 对象推入数组，然后清空缓存区，准备收集下一节的内容。同时更新当前的小节名称 (currentSection)。

如果没有遇到 ## ，就一直把普通文本塞进缓存区 (buffer.push(line))。

效果：假如你有一个文件，里面有 ## 用户偏好 和 ## 项目历史 两个部分，这个函数会把它们完美地切分成两个独立的 Chunk 数据块。 
*/
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
//重建记忆索引
export function rebuildMemoryIndex() {
  //链接数据库并清空旧数据
  const db = getDb();

  db.exec(`DELETE FROM mem_docs;`);
  db.exec(`DELETE FROM mem_fts;`);

  //扫描所有记忆文件
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

  //将切片批量存入数据库
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    const chunks = splitIntoChunks(filePath, content);//调用刚才的切片函数

    for (const chunk of chunks) {
      insertDoc.run(chunk);//存入原文档表
      insertFts.run(chunk);//存入全文检索表
    }
  }
}
/*
当你运行 npm run reindex 时，系统会：

清除旧的记忆数据库。

扫描 MEMORY.md 和 memory/ 目录下的所有笔记。

根据 Markdown 的 ## 标题，把这些笔记剪碎成一小段一小段的结构化卡片。

把这些卡片存入 SQLite 数据库的全文检索表中。

这样，下次 AI 在跟你聊天时，只要触发了检索工具，它就能在一瞬间通过 SQL 查询，从几万字的笔记中，精准抽出包含关键词的那几个特定的文本块（Chunk）来作为参考。
*/