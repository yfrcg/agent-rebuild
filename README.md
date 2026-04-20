# Agent-rebuild

复现 **OpenClaw 风格记忆系统** 的工程，基于 Node.js + TypeScript + SQLite。

---

## 项目目标

逐步复现一套类似 OpenClaw 的完整架构：三级记忆体系、session 管理、 compaction 压缩、向量检索、混合搜索。

---

## 当前架构

### 三级记忆体系

```
瞬时记忆 (sessions/*.jsonl)
    ↓ pre-compaction flush
长期事实 (MEMORY.md)
    ↓ 老化归档
日常流水 (memory/YYYY-MM-DD.md)
    ↓ 切片向量化
向量库 (mem_embeddings) + FTS (mem_fts)
    ↓ hybrid search / memoryGet
检索召回 → RRF 融合排序
```

### 目录结构

```
Agent-rebuild/
├─ apps/gateway/src/main.ts          # 命令行入口
├─ packages/
│  ├─ core/src/
│  │  ├─ bootstrap.ts   # 开机上下文加载（结构化 XML 标签）
│  │  ├─ config.ts      # 时区安全日期格式化（Intl.DateTimeFormat）
│  │  └─ types.ts       # TranscriptEntry 等基础类型
│  ├─ memory/src/
│  │  ├─ memoryIndex.ts       # splitIntoChunks + upsertFileIndex
│  │  ├─ memoryWriter.ts     # writeLongTermMemory / writeDailyMemory（安全 bullet 防误判）
│  │  ├─ hybridSearch.ts     # RRF 融合（fts + vector）
│  │  ├─ vectorSearch.ts     # Iterator + Top-K（有界内存）
│  │  ├─ embeddingStore.ts   # iterateAllEmbeddingRecords 生成器
│  │  ├─ memoryGet.ts        # 带 token 估算的截断读取（2000 tok 上限）
│  │  ├─ fileManager.ts      # upsertFileRecord + deleteFileChunks（三表级联）
│  │  ├─ compactMemory.ts    # 7天前 daily memory → MEMORY.md 归档
│  │  ├─ embedder.ts         # DashScope 1024维向量 API
│  │  ├─ vectorUtils.ts      # cosineSimilarity 余弦相似度
│  │  ├─ classifyMemory.ts   # 长期/每日记忆分类
│  │  ├─ backfillEmbeddings.ts  # 补全 pending embeddings（Promise.allSettled）
│  │  └─ types.ts            # MemoryChunk / MemorySearchResult
│  ├─ session/src/
│  │  ├─ transcript.ts      # JSONL 读写（含损坏行容错）
│  │  ├─ compact.ts         # 会话压缩（超长截断 + 有价值内容写 memory）
│  │  └─ compaction.ts      # preCompactionFlush / postCompactionRecovery
│  └─ storage/src/
│     ├─ db.ts              # better-sqlite3 单例连接
│     └─ better-sqlite3.d.ts
├─ scripts/
│  ├─ reindex.ts            # 全量清空 + 重建索引
│  ├─ backfill-embeddings.ts  # 批量补全向量
│  └─ scheduler.ts          # 后台调度（dirty FTS / pending embedding / memory 归档）
└─ workspace/               # AI 的工作区（只读防护）
   ├─ AGENTS.md / SOUL.md / USER.md / TOOLS.md / MEMORY.md / DREAMS.md
   ├─ memory/YYYY-MM-DD.md  # 每日记忆
   ├─ sessions/*.jsonl      # transcript
   └─ index/memory.sqlite   # SQLite 数据库
```

---

## 核心特性

### 内存爆炸防护（Iterator + Top-K）

向量搜索使用 `iterateAllEmbeddingRecords()` 生成器 + 动态 Top-K 队列：
- 内存占用恒定 O(limit × dim) ≈ 40KB，不受总记录数影响
- 无论 5万条还是 100万条，内存峰值不变
- 对比旧方案（全量 `stmt.all()` + 全量 `.sort()`）：从 ~1GB 降到 ~40KB

### 时区安全

`getTodayDateString()` 使用 `Intl.DateTimeFormat(timeZone: TZ)` 强制格式化，不依赖服务器本地时区：
- 默认 `Asia/Shanghai`，可通过 `TZ` 环境变量覆盖
- UTC 服务器上运行结果与新加坡本地时间一致

### 安全写入（防误判）

`memoryWriter.ts` 用行级精确比对替代子串 includes：
- `"Apple"` 不会匹配到 `"Apple Pie"`
- AI 多行输入会被压缩成单行 bullet，防止 Markdown 结构破坏

### 结构化 Bootstrap

开机上下文用 `<file name="xxx">...</file>` XML 标签包裹，方便 LLM 解析；MEMORY.md 超过 6000 字符时自动截断（保留最近 bullet），防止 System Prompt 膨胀。

### JSONL 容错

`readTranscript()` 对损坏行（进程崩溃导致的半条残码）加 try-catch 跳过，不影响整会话恢复。

---

## 环境要求

- Node.js 18+
- npm 9+

## 安装

```bash
npm install
```

## 启动命令

```bash
npm run reindex              # 全量重建索引（清空所有表后重新导入）
npm run backfill:embeddings  # 补全所有 pending 状态的向量
npm run scheduler            # 启动后台调度循环
npm run dev                  # 命令行交互入口
npm run build                # TypeScript 编译
```

## 命令行支持

```
记住：<内容>    # 写入记忆（长期 → MEMORY.md，每日 → memory/YYYY-MM-DD.md）
查记忆 <关键词>  # hybrid search 混合检索
读文件 <路径>   # 带 token 估算的文件读取
flush           # pre-compaction：把有价值 transcript 写回 memory
recover         # post-compaction：重新加载 bootstrap
help / exit
```

## 数据库表结构

| 表名 | 用途 |
|------|------|
| `mem_files` | 文件级状态（hash / fts_status / embedding_status） |
| `mem_docs` | chunk 文本（chunkId / filePath / section / content） |
| `mem_fts` | FTS5 全文索引 |
| `mem_embeddings` | 向量（1024维 DashScope） |

---

## 当前版本

**Memory Core v2** — 完整实现：
- 三级记忆写入/检索
- 向量搜索（生成器 + Top-K）
- 混合检索（RRF 融合）
- 会话压缩（flush / recover）
- 老化归档（compactMemory）
- 后台调度（scheduler）
- 全量 TypeScript 类型安全

下一步计划：多会话管理、WebSocket Gateway、多 Agent 协作。

---

许可证：MIT