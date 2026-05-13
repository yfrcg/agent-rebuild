/**
 * ?????CS336 ???
 * ???tests/session.test.ts
 * ????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe } from "node:test";

import type { TranscriptEntry } from "../packages/core/src/types";
import { SessionStore } from "../packages/gateway/sessionStore";
import { summarizeTranscriptForMemory } from "../packages/session/src/summary";

describe("session store", () => {
  test("expires stale approvals and reports expired token consumption", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-store-"));
    const store = new SessionStore();
    const session = store.createSession({ name: "Approval Test" });
    try {
      store.addPendingApproval({
        id: session.id,
        approval: {
          token: "expired-token",
          toolName: "mcp.example.deploy",
          input: {},
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          message: "expired",
        },
      });
      const consumeResult = store.consumePendingApproval(session.id, "expired-token");
      assert.equal(consumeResult.status, "expired");
      assert.equal(consumeResult.approval?.toolName, "mcp.example.deploy");
      const reloaded = store.getSession(session.id);
      assert.equal(reloaded?.pendingApprovals?.length ?? 0, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("can reject and clear pending approvals", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-store-"));
    const store = new SessionStore();
    const session = store.createSession({ name: "Reject Test" });
    try {
      const approval = (token: string) => ({
        token,
        toolName: "mcp.example.deploy",
        input: {},
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        message: "confirm",
      });
      store.addPendingApproval({ id: session.id, approval: approval("keep-token") });
      store.addPendingApproval({ id: session.id, approval: approval("reject-token") });
      const rejected = store.rejectPendingApproval(session.id, "reject-token");
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.approval?.token, "reject-token");
      const pending = store.listPendingApprovals(session.id);
      assert.deepEqual(pending.map((item) => item.token), ["keep-token"]);
      const cleared = store.clearPendingApprovals(session.id);
      assert.deepEqual(cleared.map((item) => item.token), ["keep-token"]);
      assert.equal(store.listPendingApprovals(session.id).length, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("session summary", () => {
  test("summarizeTranscriptForMemory extracts durable user facts and tasks", () => {
    const transcript: TranscriptEntry[] = [
      { id: "1", role: "user", content: "记住：我喜欢把 Gateway 做成离线优先。", createdAt: new Date().toISOString() },
      { id: "2", role: "assistant", content: "好的，我会记住这个偏好。", createdAt: new Date().toISOString() },
      { id: "3", role: "user", content: "接下来要做自动工具调用质量评测。", createdAt: new Date().toISOString() },
    ];
    const summary = summarizeTranscriptForMemory(transcript, { prefix: "[test summary]" });
    assert.equal(summary.targetHint, "long-term");
    assert.match(summary.text, /User Facts:/);
    assert.match(summary.text, /Tasks:/);
    assert.match(summary.text, /离线优先/);
    assert.match(summary.text, /自动工具调用质量评测/);
  });
});
