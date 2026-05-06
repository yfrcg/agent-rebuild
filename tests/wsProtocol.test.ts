
import assert from "node:assert/strict";
import test from "node:test";

import { fail, isWsRequest, ok } from "../packages/gateway/ws/protocol";

test("ws protocol ok formats successful responses", () => {
  assert.deepEqual(ok("req-1", { value: 1 }), {
    type: "res",
    id: "req-1",
    ok: true,
    payload: { value: 1 },
  });
});

test("ws protocol fail formats error responses", () => {
  assert.deepEqual(fail("req-1", "BAD_REQUEST", "bad", { field: "x" }), {
    type: "res",
    id: "req-1",
    ok: false,
    error: {
      code: "BAD_REQUEST",
      message: "bad",
      details: { field: "x" },
    },
  });
});

test("ws protocol accepts valid requests", () => {
  assert.equal(
    isWsRequest({
      type: "req",
      id: "req-1",
      method: "chat.send",
      params: { sessionId: "s1", input: "hello" },
      idempotencyKey: "k1",
    }),
    true
  );
});

test("ws protocol rejects invalid requests", () => {
  assert.equal(isWsRequest(null), false);
  assert.equal(isWsRequest({ type: "event", id: "x", method: "ping" }), false);
  assert.equal(isWsRequest({ type: "req", id: "", method: "ping" }), false);
  assert.equal(isWsRequest({ type: "req", id: "x", method: "unknown" }), false);
  assert.equal(
    isWsRequest({ type: "req", id: "x", method: "ping", idempotencyKey: 1 }),
    false
  );
});
