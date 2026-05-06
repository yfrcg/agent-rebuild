
import assert from "node:assert/strict";
import test from "node:test";

import { validateWsRequestParams } from "../packages/gateway/ws/schemas";
import type { WsRequest } from "../packages/gateway/ws/protocol";

test("ws schemas reject missing chat.send params", () => {
  const result = validateWsRequestParams(req("chat.send", { sessionId: "s1" }));
  assert.equal(result.ok, false);
});

test("ws schemas reject oversized chat.send input", () => {
  const result = validateWsRequestParams(req("chat.send", {
    sessionId: "s1",
    input: "x".repeat(70 * 1024),
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "BAD_REQUEST");
});

test("ws schemas reject oversized tool input", () => {
  const result = validateWsRequestParams(req("tool.call", {
    sessionId: "s1",
    toolName: "echo",
    input: { value: "x".repeat(600 * 1024) },
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "PAYLOAD_TOO_LARGE");
});

test("ws schemas accept audit.tail filters", () => {
  const result = validateWsRequestParams(req("audit.tail", { limit: 20, type: "ws.connected" }));
  assert.equal(result.ok, true);
});

test("ws schemas accept high audit.tail limit for router-side clamping", () => {
  const result = validateWsRequestParams(req("audit.tail", { limit: 999 }));
  assert.equal(result.ok, true);
});

/**
 * 函数 `req` 的职责说明。
 * `req` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function req(method: WsRequest["method"], params?: unknown): WsRequest {
  return { type: "req", id: "r1", method, params };
}
