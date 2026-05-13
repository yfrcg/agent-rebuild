/**
 * ?????CS336 ???
 * ???packages/gateway/ws/memoryWrite.ts
 * ???WebSocket ????
 * ????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { classifyMemory } from "../../memory/src/classifyMemory";
import { writeDailyMemory, writeLongTermMemory } from "../../memory/src/memoryWriter";

/**
 * WS 记忆写入范围。
 *
 * `auto` 会复用已有记忆分类器决定写入日记忆还是长期记忆，
 * 显式范围则用于客户端已经知道目标存储位置的场景。
 */
export type WsMemoryWriteScope = "daily" | "long_term" | "auto";

/** `memory.write` 请求在路由层校验后的输入结构。 */
export interface WsMemoryWriteInput {
  sessionId: string;
  content: string;
  scope?: WsMemoryWriteScope;
}

/** `memory.write` 成功后的响应结构。 */
export interface WsMemoryWriteResult {
  sessionId: string;
  scope: Exclude<WsMemoryWriteScope, "auto">;
  filePath: string;
  writtenAt: string;
}

/**
 * 将 WS 请求中的文本写入 Gateway 记忆系统。
 *
 * 写入前会把多行输入压成单行，避免客户端粘贴的大段换行破坏记忆文件格式；
 * 范围解析完成后复用 memory 包已有的写入函数。
 */
export function writeGatewayWsMemory(input: WsMemoryWriteInput): WsMemoryWriteResult {
  const content = input.content.trim().replace(/\r?\n/g, " ");
  const scope = resolveScope(content, input.scope ?? "auto");
  const filePath = scope === "long_term"
    ? writeLongTermMemory(content)
    : writeDailyMemory(content);

  return {
    sessionId: input.sessionId,
    scope,
    filePath,
    writtenAt: new Date().toISOString(),
  };
}

/** 根据显式范围或分类结果决定最终写入 daily 还是 long_term。 */
function resolveScope(
  content: string,
  scope: WsMemoryWriteScope
): Exclude<WsMemoryWriteScope, "auto"> {
  if (scope === "daily" || scope === "long_term") {
    return scope;
  }
  return classifyMemory(content) === "long-term" ? "long_term" : "daily";
}
