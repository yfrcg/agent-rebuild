
import assert from "node:assert/strict";
import test from "node:test";
import type WebSocket from "ws";

import { ConnectionManager } from "../packages/gateway/ws/connectionManager";

test("connection manager adds and removes clients", () => {
  const manager = new ConnectionManager();
  const client = manager.add(createSocket());

  assert.equal(manager.get(client.clientId), client);
  assert.equal(manager.list().length, 1);
  manager.remove(client.clientId);
  assert.equal(manager.list().length, 0);
});

test("connection manager sends responses", () => {
  const socket = createSocket();
  const manager = new ConnectionManager();
  const client = manager.add(socket);

  manager.sendResponse(client.clientId, {
    type: "res",
    id: "req1",
    ok: true,
  });

  assert.deepEqual(socket.messages[0], { type: "res", id: "req1", ok: true });
});

test("connection manager sends events with incrementing seq", () => {
  const socket = createSocket();
  const manager = new ConnectionManager();
  const client = manager.add(socket);

  manager.sendEvent(client.clientId, { type: "event", event: "heartbeat" });
  manager.sendEvent(client.clientId, { type: "event", event: "heartbeat" });

  assert.equal(socket.messages[0]?.seq, 1);
  assert.equal(socket.messages[1]?.seq, 2);
  assert.equal(typeof socket.messages[0]?.createdAt, "string");
});

test("connection manager broadcasts to subscribed sessions", () => {
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

test("connection manager drops low priority events under backpressure", () => {
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

/**
 * 函数 `createSocket` 的职责说明。
 * `createSocket` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createSocket(): WebSocket & { messages: Array<Record<string, unknown>> } {
  const messages: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    messages,
    /** 方法 `send`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    send(raw: string) {
      messages.push(JSON.parse(raw) as Record<string, unknown>);
    },
  } as unknown as WebSocket & { messages: Array<Record<string, unknown>> };
}
