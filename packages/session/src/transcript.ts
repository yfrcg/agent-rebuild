import * as fs from "fs";
import { ensureDir, resolveWorkspacePath } from "../../core/src/config";
import type { TranscriptEntry } from "../../core/src/types";

//追加单条会话消息到 JSONL 文件（append 模式，不覆盖已有内容）
export function appendTranscript(sessionId: string, entry: TranscriptEntry) {
  ensureDir(resolveWorkspacePath("sessions"));
  const filePath = resolveWorkspacePath("sessions", `${sessionId}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

//读取会话记录，返回所有消息条目
//【安全】：如果某行 JSON 损坏（如写入过程中突然断电/崩溃导致半行残码），会跳过该行而非崩溃
export function readTranscript(sessionId: string): TranscriptEntry[] {
  const filePath = resolveWorkspacePath("sessions", `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)//过滤空行
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptEntry;
      } catch {
        //遇到写入一半的残缺 JSON 行，记录警告并丢弃该行，保护整个会话不崩溃
        console.warn(`[Transcript] Skipped corrupted line in session ${sessionId}:`, line.slice(0, 50));
        return null;
      }
    })
    .filter((entry): entry is TranscriptEntry => entry !== null);//过滤掉解析失败的 null
}

//覆盖写入会话记录（compaction 时用于截断旧消息）
export function writeTranscript(sessionId: string, entries: TranscriptEntry[]) {
  ensureDir(resolveWorkspacePath("sessions"));
  const filePath = resolveWorkspacePath("sessions", `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
