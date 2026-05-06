
import assert from "node:assert/strict";
import test from "node:test";
import type WebSocket from "ws";

import { ConnectionManager } from "../packages/gateway/ws/connectionManager";

test("connection manager drops low priority events under backpressure", () => {
  const socket = createSocket({ bufferedAmount: 16 });
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

test("connection manager closes slow clients for high priority events", () => {
  const socket = createSocket({ bufferedAmount: 16 });
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

/**
 * 函数 `createSocket` 的职责说明。
 * `createSocket` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createSocket(options: {
  bufferedAmount: number;
}): WebSocket & { messages: string[]; closed: boolean } {
  return {
    readyState: 1,
    bufferedAmount: options.bufferedAmount,
    messages: [],
    closed: false,
    /** 方法 `send`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    send(raw: string) {
      this.messages.push(raw);
    },
    /** 方法 `close`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    close() {
      this.closed = true;
    },
  } as unknown as WebSocket & { messages: string[]; closed: boolean };
}
