/**
 * ?????CS336 ???
 * ???packages/session/src/transcript.ts
 * ??????????
 * ??????? transcript??????????????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "fs";
import { ensureDir, resolveWorkspacePath } from "../../core/src/config";
import type { TranscriptEntry } from "../../core/src/types";

/**
 * 以追加模式写入一条 transcript 消息。
 *
 * 采用 JSONL 格式存储，每行一条消息，
 * 这样既便于顺序追加，也便于后续流式读取和压缩。
 */
export function appendTranscript(sessionId: string, entry: TranscriptEntry) {
  ensureDir(resolveWorkspacePath("sessions"));
  const filePath = resolveWorkspacePath("sessions", `${sessionId}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * 读取某个会话的全部 transcript 消息。
 *
 * 为了增强健壮性，如果某一行 JSON 损坏，
 * 该行会被跳过，而不是让整个会话读取直接失败。
 */
export function readTranscript(sessionId: string): TranscriptEntry[] {
  const filePath = resolveWorkspacePath("sessions", `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptEntry;
      } catch {
        console.warn(`[Transcript] Skipped corrupted line in session ${sessionId}:`, line.slice(0, 50));
        return null;
      }
    })
    .filter((entry): entry is TranscriptEntry => entry !== null);
}

/**
 * 覆盖写入 transcript 文件。
 *
 * 主要在会话压缩后使用，用于把旧消息截断，只保留压缩后的剩余内容。
 */
export function writeTranscript(sessionId: string, entries: TranscriptEntry[]) {
  ensureDir(resolveWorkspacePath("sessions"));
  const filePath = resolveWorkspacePath("sessions", `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
