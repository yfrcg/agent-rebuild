import * as fs from "fs";
import { ensureDir, resolveWorkspacePath } from "../../core/src/config";
import type { TranscriptEntry } from "../../core/src/types";

export function appendTranscript(sessionId: string, entry: TranscriptEntry) {
  ensureDir(resolveWorkspacePath("sessions"));
  const filePath = resolveWorkspacePath("sessions", `${sessionId}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}
//读写历史对话
export function readTranscript(sessionId: string): TranscriptEntry[] {
  const filePath = resolveWorkspacePath("sessions", `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptEntry);
}
/*
AI Agent 的三级记忆架构已经彻底展现在我们面前了：

1.瞬时记忆 / 会话内存 (sessions/*.jsonl)：

作用：记录当前的完整对话上下文。

特点：读写极快（JSONL），无损记录，但受限于大模型上下文窗口，存满了就会触发大清洗。

2.长期事实记忆 (MEMORY.md)：

作用：从瞬时记忆中抢救出来的（触发了“记住/长期”等关键词），关于用户的核心设定和事实。

特点：作为金科玉律，可能每次对话都会通过 RAG 全量或部分加载。

3.日常流水账 (memory/2026-04-20.md)：

作用：AI 的日记本，记录每天发生的细节。

特点：文本落盘后，会被切片入库并向量化（mem_embeddings），等待未来遇到相似问题时，被 hybridSearch（混合检索）再次唤醒。
*/