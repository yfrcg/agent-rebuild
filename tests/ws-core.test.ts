import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe } from "node:test";
import type WebSocket from "ws";

import {
  authenticateWsUpgrade,
  loadGatewayWsAuthConfig,
} from "../packages/gateway/ws/auth";
import { readAuditTail } from "../packages/gateway/ws/auditTail";
import { ConnectionManager } from "../packages/gateway/ws/connectionManager";
import { IdempotencyStore } from "../packages/gateway/ws/idempotencyStore";
import { writeGatewayWsMemory } from "../packages/gateway/ws/memoryWrite";
import { fail, isWsRequest, ok, type WsEvent } from "../packages/gateway/ws/protocol";
import { ReplayBuffer, clearSessionReplay } from "../packages/gateway/ws/replayBuffer";
import { redactSecrets } from "../packages/gateway/ws/redaction";
import { RunManager } from "../packages/gateway/ws/runManager";
import { validateWsRequestParams } from "../packages/gateway/ws/schemas";
import type { WsRequest } from "../packages/gateway/ws/protocol";

describe("ws auth", () => {
  test("auto-generates token when none configured", () => {
    const config = loadGatewayWsAuthConfig({});
    // Token is auto-generated — not undefined, not empty
    assert.ok(config.token);
    assert.ok(config.token.length >= 16);
    // Connection without token is rejected
    const result = authenticateWsUpgrade({
      url: "/v1/ws",
      headers: { origin: "http://localhost:3000" },
      config,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "UNAUTHORIZED");
  });

  test("rejects missing token when token is configured", () => {
    const config = loadGatewayWsAuthConfig({ GATEWAY_WS_TOKEN: "secret123" });
    const result = authenticateWsUpgrade({
      url: "/v1/ws",
      headers: { origin: "http://localhost:3000" },
      config,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "UNAUTHORIZED");
  });

  test("accepts query token", () => {
    const config = loadGatewayWsAuthConfig({ GATEWAY_WS_TOKEN: "secret123" });
    const result = authenticateWsUpgrade({
      url: "/v1/ws?token=secret123",
      headers: { origin: "http://localhost:3000" },
      config,
    });
    assert.deepEqual(result, { ok: true });
  });

  test("accepts Authorization Bearer token", () => {
    const config = loadGatewayWsAuthConfig({ GATEWAY_WS_TOKEN: "secret123" });
    const result = authenticateWsUpgrade({
      url: "/v1/ws",
      headers: {
        origin: "http://localhost:3000",
        authorization: "Bearer secret123",
      },
      config,
    });
    assert.deepEqual(result, { ok: true });
  });

  test("rejects disallowed origin", () => {
    const config = loadGatewayWsAuthConfig({
      GATEWAY_WS_ALLOWED_ORIGINS: "http://localhost:3000",
    });
    const result = authenticateWsUpgrade({
      url: "/v1/ws",
      headers: { origin: "http://evil.example" },
      config,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "FORBIDDEN");
  });

  test("rejects empty origin when origins are explicitly configured", () => {
    const config = loadGatewayWsAuthConfig({
      GATEWAY_WS_ALLOWED_ORIGINS: "http://localhost:3000",
    });
    const result = authenticateWsUpgrade({
      url: "/v1/ws",
      headers: {},
      config,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "FORBIDDEN");
  });

  test("warns for short tokens without printing the token", () => {
    const previousWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    try {
      const config = loadGatewayWsAuthConfig({ GATEWAY_WS_TOKEN: "abc123" });
      assert.equal(config.token, "abc123");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /shorter than 8 characters/);
      assert.equal((warnings[0] ?? "").includes("abc123"), false);
    } finally {
      console.warn = previousWarn;
    }
  });
});

describe("ws audit tail", () => {
  test("reads recent JSONL entries with redaction", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ws-audit-"));
    try {
      const filePath = path.join(dir, "audit.jsonl");
      await writeFile(
        filePath,
        [
          JSON.stringify({ type: "ws.connected", token: "secret" }),
          "bad json",
          JSON.stringify({ type: "ws.request.received", sessionId: "s1" }),
        ].join("\n"),
        "utf8"
      );
      const result = readAuditTail(filePath, { limit: 10 });
      assert.equal(result.length, 2);
      assert.equal((result[0] as Record<string, unknown>).token, "[REDACTED]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ws connection manager", () => {
  test("adds and removes clients", () => {
    const manager = new ConnectionManager();
    const client = manager.add(createSocket());
    assert.equal(manager.get(client.clientId), client);
    assert.equal(manager.list().length, 1);
    manager.remove(client.clientId);
    assert.equal(manager.list().length, 0);
  });

  test("sends responses", () => {
    const socket = createSocket();
    const manager = new ConnectionManager();
    const client = manager.add(socket);
    manager.sendResponse(client.clientId, { type: "res", id: "req1", ok: true });
    assert.deepEqual(socket.messages[0], { type: "res", id: "req1", ok: true });
  });

  test("sends events with incrementing seq", () => {
    const socket = createSocket();
    const manager = new ConnectionManager();
    const client = manager.add(socket);
    manager.sendEvent(client.clientId, { type: "event", event: "heartbeat" });
    manager.sendEvent(client.clientId, { type: "event", event: "heartbeat" });
    assert.equal(socket.messages[0]?.seq, 1);
    assert.equal(socket.messages[1]?.seq, 2);
    assert.equal(typeof socket.messages[0]?.createdAt, "string");
  });

  test("broadcasts to subscribed sessions", () => {
    const socketA = createSocket();
    const socketB = createSocket();
    const manager = new ConnectionManager();
    const clientA = manager.add(socketA);
    const clientB = manager.add(socketB);
    manager.subscribe(clientA.clientId, "s1");
    manager.subscribe(clientB.clientId, "s2");
    manager.broadcastToSession("s1", {
      type: "event",
      event: "session.updated",
      sessionId: "s1",
    });
    assert.equal(socketA.messages.length, 1);
    assert.equal(socketB.messages.length, 0);
  });

  test("drops low priority events under backpressure", () => {
    const socket = createSocket();
    (socket as unknown as { bufferedAmount: number }).bufferedAmount = 1024;
    const manager = new ConnectionManager(undefined, { maxBufferedAmount: 1 });
    const client = manager.add(socket);
    manager.sendEvent(client.clientId, {
      type: "event",
      event: "chat.delta",
      payload: { delta: "x" },
    });
    assert.equal(socket.messages.length, 0);
    assert.equal(client.droppedEvents, 1);
  });
});

describe("ws backpressure", () => {
  test("drops low priority events under backpressure", () => {
    const socket = createBackpressureSocket({ bufferedAmount: 16 });
    const manager = new ConnectionManager(undefined, { maxBufferedAmount: 8 });
    const client = manager.add(socket);
    manager.sendEvent(client.clientId, {
      type: "event",
      event: "chat.delta",
      payload: { delta: "x" },
    });
    assert.equal(socket.messages.length, 0);
    assert.equal(manager.get(client.clientId)?.droppedEvents, 1);
  });

  test("closes slow clients for high priority events", () => {
    const socket = createBackpressureSocket({ bufferedAmount: 16 });
    const manager = new ConnectionManager(undefined, { maxBufferedAmount: 8 });
    const client = manager.add(socket);
    manager.sendEvent(client.clientId, {
      type: "event",
      event: "run.finished",
      payload: { runId: "r1" },
    });
    assert.equal(socket.messages.length, 0);
    assert.equal(socket.closed, true);
  });
});

describe("ws idempotency", () => {
  test("begin then get", () => {
    const store = new IdempotencyStore();
    const record = store.begin("idem-1", "chat.send", { runId: "r1" });
    const fetched = store.get("idem-1");
    assert.deepEqual(fetched, record);
    assert.equal(record.status, "running");
    assert.deepEqual(record.payload, { runId: "r1" });
  });

  test("complete keeps completed payload for duplicate keys", () => {
    const store = new IdempotencyStore();
    store.begin("idem-2", "tool.call");
    store.complete("idem-2", { ok: true });
    const duplicate = store.begin("idem-2", "tool.call", { ok: false });
    assert.equal(duplicate.status, "completed");
    assert.deepEqual(duplicate.payload, { ok: true });
  });

  test("running key does not start a new record", () => {
    const store = new IdempotencyStore();
    const first = store.begin("idem-3", "chat.send", { runId: "r1" });
    const second = store.begin("idem-3", "chat.send", { runId: "r2" });
    assert.deepEqual(second, first);
    assert.deepEqual(second.payload, { runId: "r1" });
  });

  test("cleanup removes expired records", async () => {
    const store = new IdempotencyStore({ ttlMs: 1 });
    store.begin("idem-4", "chat.send");
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.cleanup();
    assert.equal(store.get("idem-4"), undefined);
  });
});

describe("ws memory write", () => {
  test("uses controlled memory writer", async () => {
    await withTempWorkspace(() => {
      const result = writeGatewayWsMemory({
        sessionId: "s1",
        content: `WS memory write test ${Date.now()}`,
        scope: "daily",
      });
      assert.equal(result.sessionId, "s1");
      assert.equal(result.scope, "daily");
      assert.match(result.filePath, /memory[\\/]\d{4}-\d{2}-\d{2}\.md$/);
    });
  });
});

describe("ws protocol", () => {
  test("ok formats successful responses", () => {
    assert.deepEqual(ok("req-1", { value: 1 }), {
      type: "res", id: "req-1", ok: true, payload: { value: 1 },
    });
  });

  test("fail formats error responses", () => {
    assert.deepEqual(fail("req-1", "BAD_REQUEST", "bad", { field: "x" }), {
      type: "res", id: "req-1", ok: false,
      error: { code: "BAD_REQUEST", message: "bad", details: { field: "x" } },
    });
  });

  test("accepts valid requests", () => {
    assert.equal(isWsRequest({
      type: "req", id: "req-1", method: "chat.send",
      params: { sessionId: "s1", input: "hello" }, idempotencyKey: "k1",
    }), true);
  });

  test("rejects invalid requests", () => {
    assert.equal(isWsRequest(null), false);
    assert.equal(isWsRequest({ type: "event", id: "x", method: "ping" }), false);
    assert.equal(isWsRequest({ type: "req", id: "", method: "ping" }), false);
    assert.equal(isWsRequest({ type: "req", id: "x", method: "unknown" }), false);
    assert.equal(isWsRequest({ type: "req", id: "x", method: "ping", idempotencyKey: 1 }), false);
  });
});

describe("ws replay buffer", () => {
  test("appends session events and retrieves after lastSeq", () => {
    clearSessionReplay("rb-s1");
    const buffer = new ReplayBuffer({ maxEvents: 3 });
    buffer.appendSessionEvent(makeWsEvent(1, "rb-s1"));
    buffer.appendSessionEvent(makeWsEvent(2, "rb-s1"));
    buffer.appendSessionEvent(makeWsEvent(3, "rb-s1"));
    assert.equal(buffer.hasSessionHistory("rb-s1"), true);
    const events = buffer.getSessionSince("rb-s1", 0);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((item) => item.seq), [1, 2, 3]);
    const afterFirst = buffer.getSessionSince("rb-s1", 1);
    assert.deepEqual(afterFirst.map((item) => item.seq), [2, 3]);
  });

  test("reports missing session history for resync", () => {
    const buffer = new ReplayBuffer({ maxEvents: 1 });
    assert.equal(buffer.hasSessionHistory("missing-session"), false);
    assert.deepEqual(buffer.getSessionSince("missing-session", 0), []);
  });

  test("clear removes client buffer", () => {
    const buffer = new ReplayBuffer({ maxEvents: 2 });
    const ev = makeWsEvent(1);
    buffer.appendClient("c1", ev);
    buffer.clear("c1");
  });
});

describe("ws redaction", () => {
  test("removes sensitive object fields", () => {
    const redacted = redactSecrets({
      token: "abc",
      nested: { authorization: "Bearer secret", ok: true },
    });
    assert.deepEqual(redacted, {
      token: "[REDACTED]",
      nested: { authorization: "[REDACTED]", ok: true },
    });
  });

  test("masks bearer tokens in strings", () => {
    assert.equal(
      redactSecrets("Authorization: Bearer abc.def.ghi"),
      "Authorization: Bearer [REDACTED]"
    );
  });

  test("removes password and private key fields", () => {
    const redacted = redactSecrets({
      password: "p@ss",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    });
    assert.equal(redacted.password, "[REDACTED]");
    assert.equal(redacted.privateKey, "[REDACTED]");
  });
});

describe("ws run manager", () => {
  test("creates runs", () => {
    const runs = new RunManager();
    const run = runs.createRun({ sessionId: "s1", requestId: "req1" });
    assert.equal(run.sessionId, "s1");
    assert.equal(run.requestId, "req1");
    assert.equal(run.status, "running");
    assert.equal(runs.getRun(run.runId), run);
  });

  test("finishes runs", () => {
    const runs = new RunManager();
    const run = runs.createRun({ sessionId: "s1", requestId: "req1" });
    const finished = runs.finishRun(run.runId);
    assert.equal(finished?.status, "completed");
    assert.equal(typeof finished?.endedAt, "string");
  });

  test("fails runs", () => {
    const runs = new RunManager();
    const run = runs.createRun({ sessionId: "s1", requestId: "req1" });
    const failed = runs.failRun(run.runId, "boom");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, "boom");
  });

  test("cancels runs", () => {
    const runs = new RunManager();
    const run = runs.createRun({ sessionId: "s1", requestId: "req1" });
    const cancelled = runs.cancelRun(run.runId);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.abortController.signal.aborted, true);
  });

  test("lists runs by session", () => {
    const runs = new RunManager();
    runs.createRun({ sessionId: "s1", requestId: "req1" });
    runs.createRun({ sessionId: "s2", requestId: "req2" });
    assert.equal(runs.listRuns().length, 2);
    assert.equal(runs.listRuns("s1").length, 1);
  });
});

describe("ws schemas", () => {
  test("rejects missing chat.send params", () => {
    const result = validateWsRequestParams(wsReq("chat.send", { sessionId: "s1" }));
    assert.equal(result.ok, false);
  });

  test("rejects oversized chat.send input", () => {
    const result = validateWsRequestParams(wsReq("chat.send", {
      sessionId: "s1",
      input: "x".repeat(70 * 1024),
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "BAD_REQUEST");
  });

  test("rejects oversized tool input", () => {
    const result = validateWsRequestParams(wsReq("tool.call", {
      sessionId: "s1",
      toolName: "echo",
      input: { value: "x".repeat(600 * 1024) },
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "PAYLOAD_TOO_LARGE");
  });

  test("accepts audit.tail filters", () => {
    const result = validateWsRequestParams(wsReq("audit.tail", { limit: 20, type: "ws.connected" }));
    assert.equal(result.ok, true);
  });

  test("accepts high audit.tail limit for router-side clamping", () => {
    const result = validateWsRequestParams(wsReq("audit.tail", { limit: 999 }));
    assert.equal(result.ok, true);
  });
});

function createSocket(): WebSocket & { messages: Array<Record<string, unknown>> } {
  const messages: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    messages,
    send(raw: string) { messages.push(JSON.parse(raw) as Record<string, unknown>); },
  } as unknown as WebSocket & { messages: Array<Record<string, unknown>> };
}

function createBackpressureSocket(options: { bufferedAmount: number }): WebSocket & { messages: string[]; closed: boolean } {
  return {
    readyState: 1,
    bufferedAmount: options.bufferedAmount,
    messages: [],
    closed: false,
    send(raw: string) { this.messages.push(raw); },
    close() { this.closed = true; },
  } as unknown as WebSocket & { messages: string[]; closed: boolean };
}

function makeWsEvent(seq: number, sessionId?: string): WsEvent {
  return {
    type: "event",
    seq,
    event: "heartbeat",
    createdAt: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}),
  };
}

function wsReq(method: WsRequest["method"], params?: unknown): WsRequest {
  return { type: "req", id: "r1", method, params };
}

async function withTempWorkspace(run: () => void): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-ws-memory-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  const previousCwd = process.cwd();
  const previousWorkspaceRoot = process.env.WORKSPACE_ROOT;
  try {
    process.chdir(tempDir);
    process.env.WORKSPACE_ROOT = workspaceRoot;
    run();
  } finally {
    process.chdir(previousCwd);
    if (previousWorkspaceRoot === undefined) {
      delete process.env.WORKSPACE_ROOT;
    } else {
      process.env.WORKSPACE_ROOT = previousWorkspaceRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}
