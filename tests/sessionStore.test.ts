
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { SessionStore } from "../packages/gateway/sessionStore";

test("SessionStore expires stale approvals and reports expired token consumption", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-store-"));
  const snapshotPath = path.join(tempDir, "sessions.json");
  const store = new SessionStore(snapshotPath);
  const session = store.createSession({
    name: "Approval Test",
  });

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
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
    });
  }
});

test("SessionStore can reject and clear pending approvals", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-store-"));
  const snapshotPath = path.join(tempDir, "sessions.json");
  const store = new SessionStore(snapshotPath);
  const session = store.createSession({
    name: "Reject Test",
  });

  try {
    /** 函数变量 `approval`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
    const approval = (token: string) => ({
      token,
      toolName: "mcp.example.deploy",
      input: {},
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      message: "confirm",
    });

    store.addPendingApproval({
      id: session.id,
      approval: approval("keep-token"),
    });
    store.addPendingApproval({
      id: session.id,
      approval: approval("reject-token"),
    });

    const rejected = store.rejectPendingApproval(session.id, "reject-token");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.approval?.token, "reject-token");

    const pending = store.listPendingApprovals(session.id);
    assert.deepEqual(pending.map((item) => item.token), ["keep-token"]);

    const cleared = store.clearPendingApprovals(session.id);
    assert.deepEqual(cleared.map((item) => item.token), ["keep-token"]);
    assert.equal(store.listPendingApprovals(session.id).length, 0);
  } finally {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
    });
  }
});
