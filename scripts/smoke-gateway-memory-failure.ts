
import "dotenv/config";
import assert from "node:assert/strict";

import { FileAuditLogger } from "../packages/audit/auditLogger";
import { Gateway, type MemorySearch } from "../packages/gateway/gateway";
import { createGatewayRequest } from "../packages/gateway/requestHandler";
import { MockModelProvider } from "../packages/model/mockProvider";

/**
 * 一个故意抛错的记忆检索器。
 *
 * 用它来验证：当记忆层失败时，Gateway 是否还能降级继续返回模型结果。
 */
const failingMemorySearch: MemorySearch = async () => {
  throw new Error("Simulated memory search failure");
};

/**
 * 验证记忆搜索失败时的兜底链路。
 */
async function main(): Promise<void> {
  const gateway = new Gateway({
    memorySearch: failingMemorySearch,
    modelProvider: new MockModelProvider(),
    auditLogger: new FileAuditLogger("logs/test-results/gateway-smoke-memory-failure.jsonl"),
    debug: true,
  });

  const request = createGatewayRequest(
    "请测试 memory.search 失败时 Gateway 是否还能继续返回。"
  );

  const response = await gateway.handle(request);

  assert.equal(response.id, request.id);
  assert.ok(response.text.length > 0);
  assert.equal(response.memoryUsed.length, 0);
  assert.ok(response.debug);
  assert.equal(response.debug.modelProvider, "mock");
  assert.equal(response.debug.memoryCount, 0);
  assert.equal(response.debug.hasError, true);
  if (response.debug.autoToolLoop) {
    assert.equal(response.debug.autoToolLoop.attempted, false);
  }
  assert.ok(response.debug.durationMs >= 0);

  console.log("[smoke] Gateway memory failure fallback passed.");
  console.log("[smoke] debug:");
  console.log(response.debug);
  console.log("[smoke] response:");
  console.log(response.text);
}

main().catch((error) => {
  console.error("[smoke] memory failure test failed:");
  console.error(error);
  process.exitCode = 1;
});
