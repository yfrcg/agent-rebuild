import { randomUUID } from "node:crypto";

import type { TranscriptEntry } from "../core/src/types";

/**
 * 创建一条标准 transcript 消息记录。
 *
 * 这个工厂负责补齐消息 ID 和创建时间，
 * 让会话写盘时不需要每次重复拼装公共字段。
 */
export function createTranscriptEntry(
  role: TranscriptEntry["role"],
  content: string
): TranscriptEntry {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}
