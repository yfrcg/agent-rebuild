import type { GatewayToolCallRecord } from "./toolCallTypes";

/**
 * 在终端打印一次工具调用记录。
 *
 * 输出内容强调“可排查性”而不是“美观性”，
 * 因此会直接把状态、耗时、错误和结构化输出都打出来。
 */
export function printToolCallRecord(record: GatewayToolCallRecord): void {
  console.log(`[tool-call] id: ${record.id}`);
  console.log(`[tool-call] tool: ${record.toolName}`);
  console.log(`[tool-call] status: ${record.status}`);
  console.log(`[tool-call] durationMs: ${record.durationMs ?? 0}`);
  if (record.error) {
    console.log(`[tool-call] error: ${record.error}`);
  }
  console.log("[tool-call] output.metadata:");
  console.log(JSON.stringify(record.output?.metadata ?? {}, null, 2));
  console.log("[tool-call] output.content:");
  console.log(JSON.stringify(record.output?.content ?? null, null, 2));
}
