
import { readTranscript, writeTranscript } from "./transcript";
import { writeDailyMemory, writeLongTermMemory } from "../../memory/src/memoryWriter";
import { summarizeTranscriptForMemory } from "./summary";

/**
 * 单次压缩最多写出到记忆系统的旧消息条数。
 *
 * 限制这个值，是为了避免一次压缩把太多内容灌进记忆写入链路。
 */
const FLUSH_PREVIOUS = 50;

/**
 * 压缩后仍保留在 transcript 中的最近消息条数。
 *
 * 这样做的目的，是让模型即使经历压缩，也还保有最近一段对话上下文。
 */
const KEEP_RECENT = 20;

/**
 * 压缩某个会话的 transcript。
 *
 * 主要逻辑是：
 * 1. 取出需要淘汰的旧消息。
 * 2. 根据关键字决定写入长期记忆还是当日日志。
 * 3. 从 transcript 中删除旧消息，仅保留最近内容。
 */
export function compactTranscript(sessionId: string): {
  flushed: number;
  target: string;
  targetPath?: string;
  truncated: number;
} {
  const transcript = readTranscript(sessionId);

  if (transcript.length <= KEEP_RECENT) {
    return { flushed: 0, target: "none", truncated: 0 };
  }

  const toFlush = transcript.slice(
    0,
    Math.min(FLUSH_PREVIOUS, transcript.length - KEEP_RECENT)
  );
  const remaining = transcript.slice(-KEEP_RECENT);
  const summary = summarizeTranscriptForMemory(toFlush, {
    prefix: "[session compaction]",
  });

  let target: string;

  if (summary.targetHint === "long-term") {
    const targetPath = writeLongTermMemory(summary.text);
    target = "MEMORY.md";
    writeTranscript(sessionId, remaining);
    return {
      flushed: toFlush.length,
      target,
      targetPath,
      truncated: transcript.length - remaining.length,
    };
  } else {
    const targetPath = writeDailyMemory(summary.text);
    target = "daily-memory";
    writeTranscript(sessionId, remaining);
    return {
      flushed: toFlush.length,
      target,
      targetPath,
      truncated: transcript.length - remaining.length,
    };
  }
}
