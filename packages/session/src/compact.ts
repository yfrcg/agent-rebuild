import * as fs from "fs";
import * as path from "path";
import { readTranscript, writeTranscript } from "./transcript";
import { writeDailyMemory, writeLongTermMemory } from "../../memory/src/memoryWriter";

/*
真正的会话压缩：
把超长的 transcript 截断，只保留最近 N 条，
把被截掉的旧内容里有关键词的写入长期记忆，其余写入日常记忆。
*/

/**
 * 单次压缩操作最多 flush（写入记忆）的旧消息条数上限。
 * 设置为 50 条，避免一次性写入过多记忆造成 API 阻塞或文件过大。
 */
const FLUSH_PREVIOUS = 50;

/**
 * 截断后保留在 transcript 文件中的最近消息条数。
 * 确保 AI 始终有最近的上下文可参考，不会"失忆"最近发生的事。
 * 20 条对于大多数场景足以保留最近 1-2 小时的对话上下文。
 */
const KEEP_RECENT = 20;

/**
 * 对指定会话的聊天记录（transcript）进行压缩。
 *
 * 当会话消息条数超过 KEEP_RECENT 时，触发压缩逻辑：
 * 1. 从 transcript 头部取最多 FLUSH_PREVIOUS 条旧消息
 * 2. 将这些旧消息合并后根据内容关键词判断写入目标：
 *    - 包含"记住/以后/长期/我的名字/我是"等关键词 → 写入 MEMORY.md（长期记忆）
 *    - 其余内容 → 写入当日 daily-memory（日志性质）
 * 3. 被合并 flush 的消息从 transcript 中永久删除
 * 4. 只保留最近的 KEEP_RECENT 条消息
 *
 * 该函数设计为幂等（idempotent）：多次调用结果一致，不会重复写入。
 *
 * @param sessionId - 会话唯一标识（对应 sessions/{sessionId}.jsonl 文件）
 * @returns 压缩结果对象，包含：
 *   - flushed: 本次实际 flush 的消息条数（0 表示无需压缩）
 *   - target: 写入目标路径（'MEMORY.md' | 'daily-memory' | 'none'）
 *   - truncated: 被删除的旧消息总条数
 */
export function compactTranscript(sessionId: string): {
  flushed: number;
  target: string;
  truncated: number;
} {
  // 从文件系统读取该会话的完整 transcript（JSONL 格式，每行一条消息）
  const transcript = readTranscript(sessionId);

  // 若当前消息数未超过保留阈值，无需压缩，直接返回
  if (transcript.length <= KEEP_RECENT) {
    return { flushed: 0, target: "none", truncated: 0 };
  }

  // 计算需要 flush 的消息范围：
  //   - 从头部开始，最多取 FLUSH_PREVIOUS 条
  //   - 最多取到 (总条数 - KEEP_RECENT)，即保留部分之前的所有旧消息
  const toFlush = transcript.slice(
    0,
    Math.min(FLUSH_PREVIOUS, transcript.length - KEEP_RECENT)
  );

  // 剩余消息：从尾部保留 KEEP_RECENT 条
  const remaining = transcript.slice(-KEEP_RECENT);

  // 将待 flush 的消息合并为单字符串，便于统一写入记忆系统
  // 格式：每条消息格式为 "role: content"，不同消息用换行分隔
  const merged = toFlush.map((x) => `${x.role}: ${x.content}`).join("\n");

  let target: string;

  // 判断写入目标：根据内容是否包含特定关键词决定记忆强度
  // "记住/以后/长期" → 说明用户在表达需要长期保留的意图
  // "我的名字/我是"   → 说明用户在建立个人身份信息，需要跨会话保持
  if (
    merged.includes("记住") ||
    merged.includes("以后") ||
    merged.includes("长期") ||
    merged.includes("我的名字") ||
    merged.includes("我是")
  ) {
    // 写入长期记忆（MEMORY.md），可在未来会话中持续引用
    writeLongTermMemory(`[session compaction] ${merged.slice(0, 300)}`);
    target = "MEMORY.md";
  } else {
    // 写入当日日志（daily-memory），仅当日有效，用于日志追溯
    writeDailyMemory(`[session compaction] ${merged.slice(0, 300)}`);
    target = "daily-memory";
  }

  // 覆盖写入 transcript：只保留最近的 KEEP_RECENT 条，旧消息已被持久化到记忆系统
  writeTranscript(sessionId, remaining);

  // 返回压缩统计：flushed=实际写入条数，truncated=被删除的旧消息总数
  return {
    flushed: toFlush.length,
    target,
    truncated: transcript.length - remaining.length,
  };
}