
import assert from "node:assert/strict";
import test from "node:test";

import { ReplayBuffer } from "../packages/gateway/ws/replayBuffer";
import type { WsEvent } from "../packages/gateway/ws/protocol";

test("replay buffer returns events after a sequence", () => {
  const buffer = new ReplayBuffer({ maxEvents: 3 });
  buffer.append("c1", event(1));
  buffer.append("c1", event(2));
  buffer.append("c1", event(3));

  assert.deepEqual(buffer.getSince("c1", 1).map((item) => item.seq), [2, 3]);
});

test("replay buffer caps events and clears by client", () => {
  const buffer = new ReplayBuffer({ maxEvents: 2 });
  buffer.append("c1", event(1));
  buffer.append("c1", event(2));
  buffer.append("c1", event(3));

  assert.deepEqual(buffer.getSince("c1", 0).map((item) => item.seq), [2, 3]);
  buffer.clear("c1");
  assert.deepEqual(buffer.getSince("c1", 0), []);
});

test("replay buffer returns session events after lastSeq", () => {
  const buffer = new ReplayBuffer({ maxEvents: 3 });
  buffer.appendSessionEvent({ ...event(1), sessionId: "s1" });
  buffer.appendSessionEvent({ ...event(2), sessionId: "s1" });
  buffer.appendSessionEvent({ ...event(3), sessionId: "s1" });

  assert.equal(buffer.hasSessionHistory("s1"), true);
  assert.deepEqual(buffer.getSessionSince("s1", 1).map((item) => item.seq), [2, 3]);
});

test("replay buffer reports missing session history for resync", () => {
  const buffer = new ReplayBuffer({ maxEvents: 1 });

  assert.equal(buffer.hasSessionHistory("missing-session"), false);
  assert.deepEqual(buffer.getSessionSince("missing-session", 0), []);
});

/**
 * 函数 `event` 的职责说明。
 * `event` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function event(seq: number): WsEvent {
  return {
    type: "event",
    seq,
    event: "heartbeat",
    createdAt: new Date().toISOString(),
  };
}
