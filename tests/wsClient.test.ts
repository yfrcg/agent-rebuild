/**
 * ?????CS336 ???
 * ???tests/wsClient.test.ts
 * ????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import assert from "node:assert/strict";
import test from "node:test";

import { RequestManager, RequestTimeoutError, ConnectionClosedError } from "../packages/ws-client/src/requestManager";
import { EventDispatcher } from "../packages/ws-client/src/eventDispatcher";
import { ResumeManager } from "../packages/ws-client/src/resumeManager";
import { GatewayError } from "../packages/ws-client/src/types";
import type { WsEvent, WsResponse } from "../packages/ws-client/src/types";

// ─── RequestManager ──────────────────────────────────────────────────────────

test("RequestManager generates unique request IDs", () => {
  const rm = new RequestManager();
  const id1 = rm.generateId("ping");
  const id2 = rm.generateId("ping");
  assert.notEqual(id1, id2);
  assert.match(id1, /^web_ping_/);
  rm.dispose();
});

test("RequestManager creates request with correct structure", () => {
  const rm = new RequestManager();
  const { request, promise } = rm.createRequest("chat.send", {
    sessionId: "s1",
    input: "hello",
  });
  promise.catch(() => {});
  assert.equal(request.type, "req");
  assert.equal(request.method, "chat.send");
  assert.deepEqual(request.params, { sessionId: "s1", input: "hello" });
  assert.ok(request.id.startsWith("web_chat.send_"));
  rm.dispose();
});

test("RequestManager resolves pending request by ID", async () => {
  const rm = new RequestManager();
  const { request, promise } = rm.createRequest("ping", {});

  const response: WsResponse = {
    type: "res",
    id: request.id,
    ok: true,
    payload: { pong: true, serverTime: "2025-01-01T00:00:00Z" },
  };

  rm.resolve(request.id, response);
  const result = await promise;
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { pong: true, serverTime: "2025-01-01T00:00:00Z" });
  rm.dispose();
});

test("RequestManager rejects all pending on disconnect", async () => {
  const rm = new RequestManager();
  const { promise } = rm.createRequest("ping", {});

  rm.rejectAll(new ConnectionClosedError());

  await assert.rejects(promise, (err: Error) => {
    assert.equal(err.name, "ConnectionClosedError");
    return true;
  });
  rm.dispose();
});

test("RequestManager times out request after configured duration", async () => {
  const rm = new RequestManager({ timeoutMs: 50 });
  const { promise } = rm.createRequest("ping", {});

  await assert.rejects(promise, (err: Error) => {
    assert.equal(err.name, "RequestTimeoutError");
    assert.ok(err instanceof RequestTimeoutError);
    assert.equal(err.method, "ping");
    assert.equal(err.timeoutMs, 50);
    return true;
  });
  rm.dispose();
});

test("RequestManager returns false when resolving unknown ID", () => {
  const rm = new RequestManager();
  const result = rm.resolve("nonexistent", {
    type: "res",
    id: "nonexistent",
    ok: true,
  });
  assert.equal(result, false);
  rm.dispose();
});

test("RequestManager shouldInjectIdempotencyKey for write methods", () => {
  const rm = new RequestManager();
  assert.equal(rm.shouldInjectIdempotencyKey("chat.send"), true);
  assert.equal(rm.shouldInjectIdempotencyKey("tool.call"), true);
  assert.equal(rm.shouldInjectIdempotencyKey("memory.write"), true);
  assert.equal(rm.shouldInjectIdempotencyKey("session.create"), true);
  assert.equal(rm.shouldInjectIdempotencyKey("approval.confirm"), true);
  assert.equal(rm.shouldInjectIdempotencyKey("approval.reject"), true);
  assert.equal(rm.shouldInjectIdempotencyKey("ping"), false);
  assert.equal(rm.shouldInjectIdempotencyKey("session.list"), false);
  assert.equal(rm.shouldInjectIdempotencyKey("memory.search"), false);
  assert.equal(rm.shouldInjectIdempotencyKey("tool.list"), false);
  assert.equal(rm.shouldInjectIdempotencyKey("audit.tail"), false);
  rm.dispose();
});

test("RequestManager injects idempotencyKey into request", () => {
  const rm = new RequestManager();
  const key = rm.generateIdempotencyKey("chat.send");
  assert.match(key, /^web_ik_chat\.send_/);

  const { request, promise } = rm.createRequest("chat.send", { sessionId: "s1", input: "hi" }, key);
  promise.catch(() => {});
  assert.equal(request.idempotencyKey, key);
  rm.dispose();
});

test("RequestManager disposes and rejects all pending", async () => {
  const rm = new RequestManager();
  const { promise } = rm.createRequest("ping", {});
  rm.dispose();

  await assert.rejects(promise, (err: Error) => {
    assert.equal(err.name, "Error");
    assert.match(err.message, /disposed/);
    return true;
  });
});

test("RequestManager tracks pending count", () => {
  const rm = new RequestManager();
  assert.equal(rm.pendingCount, 0);

  const { promise: p1 } = rm.createRequest("ping", {});
  p1.catch(() => {});
  assert.equal(rm.pendingCount, 1);

  const { promise: p2 } = rm.createRequest("session.list", {});
  p2.catch(() => {});
  assert.equal(rm.pendingCount, 2);

  rm.dispose();
});

// ─── EventDispatcher ─────────────────────────────────────────────────────────

test("EventDispatcher dispatches events to registered handlers", () => {
  const ed = new EventDispatcher();
  const received: WsEvent[] = [];

  ed.on("run.started", (_, raw) => {
    received.push(raw);
  });

  const event: WsEvent = {
    type: "event",
    event: "run.started",
    seq: 1,
    createdAt: "2025-01-01T00:00:00Z",
    payload: { sessionId: "s1" },
  };

  ed.dispatch(event);
  assert.equal(received.length, 1);
  assert.equal(received[0].event, "run.started");
  ed.dispose();
});

test("EventDispatcher unsubscribes correctly", () => {
  const ed = new EventDispatcher();
  let count = 0;

  const unsub = ed.on("heartbeat", () => {
    count++;
  });

  const event: WsEvent = {
    type: "event",
    event: "heartbeat",
    seq: 1,
    createdAt: "2025-01-01T00:00:00Z",
    payload: { serverTime: "2025-01-01T00:00:00Z" },
  };

  ed.dispatch(event);
  assert.equal(count, 1);

  unsub();
  ed.dispatch(event);
  assert.equal(count, 1);
  ed.dispose();
});

test("EventDispatcher tracks last seq per sessionId", () => {
  const ed = new EventDispatcher();

  ed.dispatch({
    type: "event",
    event: "run.progress",
    seq: 5,
    sessionId: "s1",
    createdAt: "2025-01-01T00:00:00Z",
    payload: { sessionId: "s1" },
  });

  ed.dispatch({
    type: "event",
    event: "run.progress",
    seq: 5,
    sessionId: "s1",
    createdAt: "2025-01-01T00:00:00Z",
    payload: { sessionId: "s1" },
  });

  assert.equal(ed.getLastSeq("s1"), 5);
  ed.dispose();
});

test("EventDispatcher dispatches different seq values", () => {
  const ed = new EventDispatcher();
  const received: WsEvent[] = [];

  ed.on("run.progress", (_, raw) => {
    received.push(raw);
  });

  const event1: WsEvent = {
    type: "event",
    event: "run.progress",
    seq: 1,
    sessionId: "s1",
    createdAt: "2025-01-01T00:00:00Z",
    payload: { sessionId: "s1" },
  };

  const event2: WsEvent = {
    type: "event",
    event: "run.progress",
    seq: 2,
    sessionId: "s1",
    createdAt: "2025-01-01T00:00:01Z",
    payload: { sessionId: "s1" },
  };

  ed.dispatch(event1);
  ed.dispatch(event2);
  assert.equal(received.length, 2);
  ed.dispose();
});

test("EventDispatcher batches chat.delta events", async () => {
  const ed = new EventDispatcher({ deltaBatchMs: 30 });
  const batches: WsEvent[][] = [];

  ed.onDelta((events) => {
    batches.push([...events]);
  });

  const delta1: WsEvent = {
    type: "event",
    event: "chat.delta",
    seq: 1,
    createdAt: "2025-01-01T00:00:00Z",
    payload: { text: "Hello" },
  };

  const delta2: WsEvent = {
    type: "event",
    event: "chat.delta",
    seq: 2,
    createdAt: "2025-01-01T00:00:00Z",
    payload: { text: " World" },
  };

  ed.dispatch(delta1);
  ed.dispatch(delta2);

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  ed.dispose();
});

test("EventDispatcher handles multiple event types independently", () => {
  const ed = new EventDispatcher();
  const runEvents: WsEvent[] = [];
  const toolEvents: WsEvent[] = [];

  ed.on("run.started", (_, raw) => runEvents.push(raw));
  ed.on("tool.started", (_, raw) => toolEvents.push(raw));

  ed.dispatch({
    type: "event",
    event: "run.started",
    seq: 1,
    createdAt: "2025-01-01T00:00:00Z",
    payload: {},
  });

  ed.dispatch({
    type: "event",
    event: "tool.started",
    seq: 2,
    createdAt: "2025-01-01T00:00:00Z",
    payload: {},
  });

  assert.equal(runEvents.length, 1);
  assert.equal(toolEvents.length, 1);
  ed.dispose();
});

// ─── ResumeManager ───────────────────────────────────────────────────────────

test("ResumeManager tracks seq from events", () => {
  const rm = new ResumeManager({ requestManager: new RequestManager() });

  rm.trackEvent({
    type: "event",
    event: "run.started",
    seq: 5,
    sessionId: "s1",
    createdAt: "2025-01-01T00:00:00Z",
    payload: {},
  });

  rm.trackEvent({
    type: "event",
    event: "chat.delta",
    seq: 10,
    sessionId: "s1",
    createdAt: "2025-01-01T00:00:00Z",
    payload: {},
  });

  rm.addActiveSession("s1");
  const params = rm.buildResumeParams();
  assert.ok(Array.isArray(params));
  assert.equal(params.length, 1);
  assert.equal(params[0].sessionId, "s1");
  assert.equal(params[0].lastSeq, 10);
  rm.dispose();
});

test("ResumeManager manages active sessions", () => {
  const rm = new ResumeManager({ requestManager: new RequestManager() });

  rm.addActiveSession("s1");
  rm.addActiveSession("s2");
  rm.removeActiveSession("s1");

  rm.trackEvent({
    type: "event",
    event: "run.started",
    seq: 1,
    sessionId: "s1",
    createdAt: "2025-01-01T00:00:00Z",
    payload: {},
  });

  rm.trackEvent({
    type: "event",
    event: "run.started",
    seq: 3,
    sessionId: "s2",
    createdAt: "2025-01-01T00:00:00Z",
    payload: {},
  });

  const params = rm.buildResumeParams();
  assert.equal(params.length, 1);
  assert.equal(params[0].sessionId, "s2");
  assert.equal(params[0].lastSeq, 3);
  rm.dispose();
});

test("ResumeManager returns empty array when no active sessions", () => {
  const rm = new ResumeManager({ requestManager: new RequestManager() });
  const params = rm.buildResumeParams();
  assert.deepEqual(params, []);
  rm.dispose();
});

test("ResumeManager tracks highest seq per session", () => {
  const rm = new ResumeManager({ requestManager: new RequestManager() });
  rm.addActiveSession("s1");

  for (let seq = 1; seq <= 5; seq++) {
    rm.trackEvent({
      type: "event",
      event: "chat.delta",
      seq,
      sessionId: "s1",
      createdAt: "2025-01-01T00:00:00Z",
      payload: {},
    });
  }

  const params = rm.buildResumeParams();
  assert.equal(params[0].lastSeq, 5);
  rm.dispose();
});

// ─── GatewayError ────────────────────────────────────────────────────────────

test("GatewayError preserves code, message, and details", () => {
  const err = new GatewayError("BAD_REQUEST", "invalid params", { field: "sessionId" });
  assert.equal(err.code, "BAD_REQUEST");
  assert.equal(err.message, "invalid params");
  assert.deepEqual(err.details, { field: "sessionId" });
  assert.equal(err.name, "GatewayError");
  assert.ok(err instanceof Error);
});

test("GatewayError works without details", () => {
  const err = new GatewayError("NOT_FOUND", "session not found");
  assert.equal(err.code, "NOT_FOUND");
  assert.equal(err.details, undefined);
});

// ─── Integration: RequestManager with idempotency ────────────────────────────

test("createRequest with idempotencyKey adds it to WsRequest", () => {
  const rm = new RequestManager();
  const key = "test-idempotency-key-123";
  const { request, promise } = rm.createRequest(
    "session.create",
    { name: "test" },
    key
  );
  promise.catch(() => {});

  assert.equal(request.idempotencyKey, key);
  assert.equal(request.method, "session.create");
  rm.dispose();
});

test("createRequest without idempotencyKey omits it from WsRequest", () => {
  const rm = new RequestManager();
  const { request, promise } = rm.createRequest("session.list", {});
  promise.catch(() => {});

  assert.equal(request.idempotencyKey, undefined);
  rm.dispose();
});

// ─── Integration: EventDispatcher dispatch + tracking ─────────────────────────

test("EventDispatcher state.resync_required triggers handler", () => {
  const ed = new EventDispatcher();
  let resyncTriggered = false;

  ed.on("state.resync_required", () => {
    resyncTriggered = true;
  });

  ed.dispatch({
    type: "event",
    event: "state.resync_required",
    seq: 99,
    createdAt: "2025-01-01T00:00:00Z",
    payload: { reason: "gap_detected" },
  });

  assert.equal(resyncTriggered, true);
  ed.dispose();
});

test("EventDispatcher approval.required handler receives full payload", () => {
  const ed = new EventDispatcher();
  let receivedPayload: unknown = null;

  ed.on("approval.required", (payload) => {
    receivedPayload = payload;
  });

  const payload = {
    token: "tk-123",
    toolName: "fs_write",
    input: { path: "/tmp/test.txt" },
    expiresAt: "2025-01-01T01:00:00Z",
  };

  ed.dispatch({
    type: "event",
    event: "approval.required",
    seq: 42,
    sessionId: "s1",
    createdAt: "2025-01-01T00:00:00Z",
    payload,
  });

  assert.deepEqual(receivedPayload, payload);
  ed.dispose();
});
