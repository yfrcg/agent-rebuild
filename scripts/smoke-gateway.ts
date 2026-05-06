
import "dotenv/config";
import assert from "node:assert/strict";

import { FileAuditLogger } from "../packages/audit/auditLogger";
import { Gateway, type MemorySearch } from "../packages/gateway/gateway";
import { createGatewayRequest } from "../packages/gateway/requestHandler";
import { MockModelProvider } from "../packages/model/mockProvider";

/**
 * 一个最小化的假记忆检索实现。
 *
 * 目的是让 smoke test 在主链路上稳定命中一条记忆，
 * 从而验证“检索 -> 上下文构建 -> 模型响应”这条链路没有断。
 */
const smokeMemorySearch: MemorySearch = async (query) => [
  {
    id: "smoke-memory-001",
    content: `This is a smoke test memory. User question: ${query}`,
    score: 1,
    source: "smoke-test",
  },
];

/**
 * 验证 Gateway 主链路是否正常工作。
 */
async function main(): Promise<void> {
  const gateway = new Gateway({
    memorySearch: smokeMemorySearch,
    modelProvider: new MockModelProvider(),
    auditLogger: new FileAuditLogger("logs/test-results/gateway-smoke-test.jsonl"),
    debug: true,
  });

  const request = createGatewayRequest("请测试 Gateway 主链路是否正常。");
  const response = await gateway.handle(request);

  assert.equal(response.id, request.id);
  assert.equal(response.error, undefined);
  assert.ok(response.text.length > 0);
  assert.equal(response.memoryUsed.length, 1);
  assert.equal(response.memoryUsed[0]?.id, "smoke-memory-001");
  assert.ok(response.debug);
  assert.equal(response.debug.modelProvider, "mock");
  assert.equal(response.debug.memoryCount, 1);
  assert.equal(response.debug.hasError, false);
  assert.equal(response.debug.autoToolLoop?.attempted, false);
  assert.ok(response.debug.durationMs >= 0);

  console.log("[smoke] Gateway main flow passed.");
  console.log("[smoke] debug:");
  console.log(response.debug);
  console.log("[smoke] response:");
  console.log(response.text);
}

main().catch((error) => {
  console.error("[smoke] failed:");
  console.error(error);
  process.exitCode = 1;
});
