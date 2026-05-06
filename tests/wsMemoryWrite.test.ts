
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { closeDb } from "../packages/storage/src/db";
import { writeGatewayWsMemory } from "../packages/gateway/ws/memoryWrite";

test("ws memory.write uses controlled memory writer", async () => {
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

/**
 * 函数 `withTempWorkspace` 的职责说明。
 * `withTempWorkspace` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function withTempWorkspace(run: () => void): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-ws-memory-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  const previousCwd = process.cwd();
  const previousWorkspaceRoot = process.env.WORKSPACE_ROOT;
  try {
    closeDb();
    process.chdir(tempDir);
    process.env.WORKSPACE_ROOT = workspaceRoot;
    run();
  } finally {
    closeDb();
    process.chdir(previousCwd);
    if (previousWorkspaceRoot === undefined) {
      delete process.env.WORKSPACE_ROOT;
    } else {
      process.env.WORKSPACE_ROOT = previousWorkspaceRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}
