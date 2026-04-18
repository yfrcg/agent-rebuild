# TOOLS.md

## 工具约定
- 记忆系统的真实数据来源是 workspace 下的 Markdown 文件。
- transcript 采用 append-only 方式写入 sessions/*.jsonl。
- memory_search 负责查找相关记忆。
- memory_get 负责精确读取某个记忆文件的内容。
- 索引文件放在 workspace/index/ 目录下。

## 当前阶段实现约定
- 第一版先使用 SQLite + FTS 作为记忆检索方案。
- 第一版先不接入 embedding 检索。
- 第一版先通过命令行或简单入口测试，不急着做前端界面。