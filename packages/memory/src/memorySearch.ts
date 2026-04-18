import { getDb } from "../../storage/src/db";
import type { SearchHit } from "../../core/src/types";

/*
这段代码是 AI Agent 记忆系统的“大脑检索器”：基于双重策略的记忆查询引擎。

如果说上一段代码负责“把日记剪碎存起来”，那么这段 memorySearch 代码的作用就是：当 AI 需要回忆某个事情时，提供一个搜索工具，帮它迅速从数据库里找出最相关的记忆片段。

这段代码非常精妙，它采用了一种叫做**“优雅降级（Graceful Degradation）”**的容错设计。
*/
//接受一个搜索词（query），并返回匹配的记忆片段数组SearchHit[]
export function memorySearch(query: string, limit = 5): SearchHit[] {
  const db = getDb();
  //第一重检索：高速全文检索（FTS  MATCH）
  try {
    const ftsStmt = db.prepare(`
      SELECT chunkId, filePath, section, content
      FROM mem_fts
      WHERE mem_fts MATCH ?
      LIMIT ?
    `);

    const ftsHits = ftsStmt.all(query, limit) as SearchHit[];
    if (ftsHits.length > 0) {
      return ftsHits;
    }
  } catch {
    // FTS 查询语法不合法时，自动降级到 LIKE 检索
  }
  /*
  原理：这里查询的是上一段代码中建立的 mem_fts 虚拟表。它使用了 SQLite 专属的 MATCH 操作符。

  优势：极速。全文本检索底层使用了倒排索引，找词速度比普通的遍历查询快几十上百倍。

  为什么会有 try...catch？（重点）：SQLite 的 MATCH 语法非常严格。如果 AI 在搜索时，输入的 query 里包含了未闭合的引号，或者像 *、OR、AND 这样的特殊逻辑符号但格式不对，SQLite 数据库就会直接报错崩溃。为了防止 AI 乱输搜索词导致整个程序死掉，这里用 try...catch 捕获了潜在的错误。
  */
  //第二重检索：字符串匹配（LIKE）：利用数据库底层LIKE一层层扫表
  const likeStmt = db.prepare(`
    SELECT chunkId, filePath, section, content
    FROM mem_docs
    WHERE content LIKE ?
    ORDER BY filePath ASC
    LIMIT ?
  `);

  return likeStmt.all(`%${query}%`, limit) as SearchHit[];
}
/*
举个实际运行的例子：
场景 1：AI 正常搜索

AI 调用：memorySearch("咖啡偏好")

流程：走 MATCH 高速查询，瞬间在 mem_fts 表中找到包含“咖啡偏好”的切片（Chunk），直接返回前 5 条。

场景 2：AI 发出了带有非法符号的“糟糕”搜索

AI 调用：memorySearch("coffee OR (sugar") （注意这里左括号没闭合）

流程：

系统尝试用 MATCH 搜索。

SQLite 发现语法错误，立马抛出异常。

代码被 catch 捕获，不崩溃，默默咽下错误。

启动“兜底方案”，使用 LIKE '%coffee OR (sugar%' 去基础表里硬搜。

依然平稳地返回结果（如果有的话）。

总结：这个函数既保证了常态下的搜索极速，又保证了面对复杂不可控的 AI 输入时的绝对稳定。
*/