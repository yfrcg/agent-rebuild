import assert from "node:assert/strict";

import { FileAuditLogger } from "../packages/audit/auditLogger";
import { Gateway, type MemorySearch } from "../packages/gateway/gateway";
import { createGatewayRequest } from "../packages/gateway/requestHandler";
import { MockModelProvider } from "../packages/model/mockProvider";

const smokeMemorySearch: MemorySearch = async (query) => {
  return [
    {
      id: "smoke-memory-001",
      content: `这是一条 smoke test 记忆。用户问题是：${query}`,
      score: 1,
      source: "smoke-test",
    },
  ];
};

async function main(): Promise<void> {
  const gateway = new Gateway({
    memorySearch: smokeMemorySearch,
    modelProvider: new MockModelProvider(),
    auditLogger: new FileAuditLogger("logs/gateway-smoke-test.jsonl"),
    debug: true,
  });

  const request = createGatewayRequest("请测试 Gateway v0.1 主链路是否正常。");
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
  assert.ok(response.debug.durationMs >= 0);

  console.log("[smoke] Gateway v0.1 main flow passed.");
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