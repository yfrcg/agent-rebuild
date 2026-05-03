import { readTranscript } from "./transcript";
import { writeDailyMemory, writeLongTermMemory } from "../../memory/src/memoryWriter";
import { loadBootstrapContext } from "../../core/src/bootstrap";
import { summarizeTranscriptForMemory } from "./summary";

/**
 * 在真正清理上下文之前，把最近的重要消息先写进记忆系统。
 *
 * 这是“压缩前保险丝”：
 * 即使后续 transcript 被大量截断，也至少能把最近关键内容保留下来。
 */
export function preCompactionFlush(sessionId: string) {
  const transcript = readTranscript(sessionId);
  const recent = transcript.slice(-12);

  if (recent.length === 0) {
    return { ok: true, target: "none", message: "No transcript to flush." };
  }

  const summary = summarizeTranscriptForMemory(recent, {
    prefix: "[pre-compaction flush]",
    maxItemsPerSection: 3,
  });

  if (summary.targetHint === "long-term") {
    const targetPath = writeLongTermMemory(summary.text);
    return {
      ok: true,
      target: "MEMORY.md",
      targetPath,
      message: "Flushed recent transcript into MEMORY.md.",
    };
  }

  const targetPath = writeDailyMemory(summary.text);
  return {
    ok: true,
    target: "daily-memory",
    targetPath,
    message: "Flushed recent transcript into daily memory.",
  };
}

/**
 * 在上下文压缩后重新加载 bootstrap 上下文。
 *
 * 作用不是“恢复聊天记录”，而是“恢复系统身份和工作规则”，
 * 让模型在压缩后依旧知道自己是谁、拥有哪些能力、要遵守哪些边界。
 */
export function postCompactionRecovery() {
  return loadBootstrapContext();
}
