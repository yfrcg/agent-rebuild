# Agent-rebuild

一个正在复现 **OpenClaw 风格记忆系统** 的工程项目。  
当前已经完成第一版 **Memory Core MVP**，实现了基于 workspace 文件的显式记忆、会话 transcript、SQLite 索引检索，以及基础的 flush / recover 生命周期。

---

## 项目目标

这个项目的目标不是只做一个聊天机器人，而是逐步复现一套类似 OpenClaw 的完整架构。  
当前阶段优先完成的是：

- workspace 显式记忆系统
- transcript 持久化
- 记忆检索
- compaction 前后的基础恢复逻辑

后续会继续扩展到：

- 更强的记忆检索（embedding / hybrid search）
- 更智能的 compaction 摘要
- gateway / WebSocket 协议层
- 多会话 / 多 agent 扩展
- 前端入口

---

## 当前已完成能力

当前版本已经完成并验证了以下链路：

1. 启动时自动读取 workspace 中的核心记忆文件
2. 支持将信息写入 daily memory
3. 支持从 SQLite 索引中检索记忆
4. 支持精确读取指定记忆文件
5. 支持 pre-compaction flush
6. 支持 post-compaction recovery
7. 项目可正常 TypeScript 编译
8. 命令行入口可正常运行

当前已经跑通的完整流程是：

```text
启动读取 → 写记忆 → 查记忆 → 读文件 → flush → recover
项目结构
Agent-rebuild/
├─ apps/
│  └─ gateway/
│     └─ src/
│        └─ main.ts
│
├─ packages/
│  ├─ core/
│  │  └─ src/
│  │     ├─ bootstrap.ts
│  │     ├─ config.ts
│  │     └─ types.ts
│  │
│  ├─ memory/
│  │  └─ src/
│  │     ├─ classifyMemory.ts
│  │     ├─ memoryGet.ts
│  │     ├─ memoryIndex.ts
│  │     ├─ memorySearch.ts
│  │     └─ memoryWriter.ts
│  │
│  ├─ session/
│  │  └─ src/
│  │     ├─ compaction.ts
│  │     └─ transcript.ts
│  │
│  └─ storage/
│     └─ src/
│        ├─ better-sqlite3.d.ts
│        └─ db.ts
│
├─ scripts/
│  └─ reindex.ts
│
├─ workspace/
│  ├─ AGENTS.md
│  ├─ SOUL.md
│  ├─ USER.md
│  ├─ TOOLS.md
│  ├─ MEMORY.md
│  ├─ WORKFLOW_AUTO.md
│  ├─ DREAMS.md
│  ├─ memory/
│  ├─ sessions/
│  ├─ index/
│  └─ logs/
│
├─ dist/
├─ package.json
├─ tsconfig.json
└─ README.md
记忆系统设计
1. workspace 文件记忆

记忆系统的真实来源不是模型上下文本身，而是 workspace/ 下的 Markdown 文件。

核心文件包括：

AGENTS.md：系统规则
SOUL.md：回答风格
USER.md：用户偏好
TOOLS.md：工具约定
MEMORY.md：长期记忆
memory/YYYY-MM-DD.md：每日记忆
WORKFLOW_AUTO.md：恢复流程说明
DREAMS.md：待提升信息
2. transcript 持久化

每轮输入会先写入：

workspace/sessions/<sessionId>.jsonl

用于后续 flush / recover 和上下文重建。

3. 索引与检索

当前版本使用：

better-sqlite3
SQLite FTS5
LIKE 降级检索

索引文件存放在：

workspace/index/memory.sqlite
4. flush / recover

当前版本已支持：

preCompactionFlush()：把最近 transcript 中的重要信息写回 memory
postCompactionRecovery()：重新加载 bootstrap 和记忆文件
环境要求

建议环境：

Node.js 18+
npm 9+
Linux / macOS / Windows 均可
TypeScript 6.x
安装依赖
npm install

如果国内安装较慢，可切换镜像源后再安装。

启动方式
1. 重建索引
npm run reindex
2. 启动命令行入口
npm run dev
3. 编译项目
npm run build
当前支持的命令

启动后，命令行支持以下输入：

记住：<内容>
查记忆 <关键词>
读文件 <相对路径>
flush
recover
help
exit
示例
写入记忆
记住：今天正在测试第一版记忆重建系统
检索记忆
查记忆 测试
读取记忆文件
读文件 memory/2026-04-18.md
执行 flush
flush
执行 recover
recover
当前状态

当前版本是：

Memory Core MVP

它已经证明以下设计是可运行的：

workspace 显式记忆
daily / long-term memory 写入
transcript 持久化
SQLite 索引检索
flush / recover 生命周期

但它还不是最终版，暂时还没有：

embedding 检索
LLM 驱动的高级 memory extraction
真正的 WebSocket gateway
多 agent 协作
前端界面
完整自动化测试
下一步计划

接下来的开发重点建议按这个顺序推进：

固化当前版本，作为第一版基线
增强 memorySearch，支持 embedding / hybrid search
增强 preCompactionFlush，引入 LLM 提取逻辑
继续扩展 gateway 生命周期
再向完整 OpenClaw 风格架构推进
开发说明

当前项目使用的是：

根目录统一 package.json
根目录统一 tsconfig.json
packages/* 作为逻辑分层，而不是独立发布模块

也就是说，目前这是一个 单仓库、统一编译、统一运行 的工程，不是 monorepo publish 结构。

许可证

当前项目暂未添加许可证，后续再根据需要补充。