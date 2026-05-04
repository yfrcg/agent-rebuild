import assert from "node:assert/strict";

import { FileAuditLogger } from "../packages/audit/auditLogger";
import { Gateway, type MemorySearch } from "../packages/gateway/gateway";
import { createGatewayRequest } from "../packages/gateway/requestHandler";
import type { ChatMessage } from "../packages/gateway/types";
import type { ModelProvider, ModelResponse } from "../packages/model/types";

/**
 * 固定返回一条命中的 smoke test 记忆。
 */
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

/**
 * 一个故意失败的模型提供商。
 *
 * 用它验证模型调用失败时，Gateway 是否仍然能返回可预期的错误响应。
 */
class FailingModelProvider implements ModelProvider {
  name = "failing-model";

  /**
   * 始终抛出错误，模拟上游模型服务故障。
   */
  async generate(_messages: ChatMessage[]): Promise<ModelResponse> {
    throw new Error("Simulated model provider failure");
  }
}

/**
 * 验证模型失败兜底逻辑。
 */
async function main(): Promise<void> {
  const gateway = new Gateway({
    memorySearch: smokeMemorySearch,
    modelProvider: new FailingModelProvider(),
    auditLogger: new FileAuditLogger("logs/test-results/gateway-smoke-model-failure.jsonl"),
    debug: true,
  });

  const request = createGatewayRequest(
    "请测试模型失败时 Gateway 是否能返回错误响应。"
  );

  const response = await gateway.handle(request);

  assert.equal(response.id, request.id);
  assert.ok(response.text.length > 0);
  assert.ok(response.error);
  assert.match(response.error, /Simulated model provider failure/);

  assert.equal(response.memoryUsed.length, 1);
  assert.equal(response.memoryUsed[0]?.id, "smoke-memory-001");

  assert.ok(response.debug);
  assert.equal(response.debug.modelProvider, "failing-model");
  assert.equal(response.debug.memoryCount, 1);
  assert.equal(response.debug.hasError, true);
  assert.ok(response.debug.durationMs >= 0);

  console.log("[smoke] Gateway model failure fallback passed.");
  console.log("[smoke] error:");
  console.log(response.error);
  console.log("[smoke] debug:");
  console.log(response.debug);
  console.log("[smoke] response:");
  console.log(response.text);
}

main().catch((error) => {
  console.error("[smoke] model failure test failed:");
  console.error(error);
  process.exitCode = 1;
});
