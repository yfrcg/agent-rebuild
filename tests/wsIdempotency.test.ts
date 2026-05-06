
import assert from "node:assert/strict";
import test from "node:test";

import { IdempotencyStore } from "../packages/gateway/ws/idempotencyStore";

test("idempotency store begin then get", () => {
  const store = new IdempotencyStore();
  const record = store.begin("key-1", "chat.send", { runId: "r1" });

  assert.equal(store.get("key-1"), record);
  assert.equal(record.status, "running");
  assert.deepEqual(record.payload, { runId: "r1" });
});

test("idempotency store complete keeps completed payload for duplicate keys", () => {
  const store = new IdempotencyStore();
  store.begin("key-1", "tool.call");
  store.complete("key-1", { ok: true });

  const duplicate = store.begin("key-1", "tool.call", { ok: false });
  assert.equal(duplicate.status, "completed");
  assert.deepEqual(duplicate.payload, { ok: true });
});

test("idempotency store running key does not start a new record", () => {
  const store = new IdempotencyStore();
  const first = store.begin("key-1", "chat.send", { runId: "r1" });
  const second = store.begin("key-1", "chat.send", { runId: "r2" });

  assert.equal(second, first);
  assert.deepEqual(second.payload, { runId: "r1" });
});

test("idempotency store cleanup removes expired records", async () => {
  const store = new IdempotencyStore({ ttlMs: 1 });
  store.begin("key-1", "chat.send");
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.cleanup();

  assert.equal(store.get("key-1"), undefined);
});
