/**
 * ?????CS336 ???
 * ???tests/projectBinding.test.ts
 * ????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { SessionStore } from "../packages/gateway/sessionStore";
import { SessionManager } from "../packages/gateway/sessionManager";
import { ToolCallExecutor } from "../packages/gateway/toolCallExecutor";
import { ToolRegistry } from "../packages/gateway/toolRegistry";
import { PermissionPolicy } from "../packages/gateway/permissionPolicy";
import { createBuiltinToolRegistry } from "../packages/gateway/builtinTools";
import { createGatewayToolCallRequest } from "../packages/gateway/toolCallFactory";
import { extractProjectBoundary } from "../packages/gateway/sessionTypes";
import type { GatewayTool } from "../packages/gateway/toolTypes";

/**
 * 函数 `createTempWorkspace` 的职责说明。
 * `createTempWorkspace` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-project-binding-"));
}

/**
 * 函数 `createTestProjectDir` 的职责说明。
 * `createTestProjectDir` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createTestProjectDir(workspace: string, name = "test-project"): string {
  const projectDir = path.join(workspace, name);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "index.ts"), "export {};\n", "utf8");
  return projectDir;
}

/**
 * 函数 `createSessionManager` 的职责说明。
 * `createSessionManager` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createSessionManager(workspace: string): SessionManager {
  const store = new SessionStore();
  const manager = new SessionManager(store);
  manager.createSession("Test Session");
  return manager;
}

/**
 * 函数 `createRegistryWithDummyTools` 的职责说明。
 * `createRegistryWithDummyTools` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createRegistryWithDummyTools(): ToolRegistry {
  const registry = new ToolRegistry();
  const dummyTools: GatewayTool[] = [
    {
      name: "file.read",
      description: "read a file",
      readOnly: true,
      permissionLevel: "unrestricted",
    },
    {
      name: "file.write",
      description: "write a file",
      readOnly: false,
      sideEffect: true,
      permissionLevel: "unrestricted",
    },
    {
      name: "file.edit",
      description: "edit a file",
      readOnly: false,
      sideEffect: true,
      permissionLevel: "unrestricted",
    },
    {
      name: "shell.run",
      description: "run a shell command",
      readOnly: false,
      sideEffect: true,
      permissionLevel: "unrestricted",
    },
    {
      name: "bash.run",
      description: "run a bash command",
      readOnly: false,
      sideEffect: true,
      permissionLevel: "unrestricted",
    },
  ];
  for (const tool of dummyTools) {
    registry.register(tool);
  }
  return registry;
}

/**
 * 函数 `createToolCallExecutor` 的职责说明。
 * `createToolCallExecutor` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createToolCallExecutor(workspace: string, allowBypass = true): ToolCallExecutor {
  const registry = createRegistryWithDummyTools();
  return new ToolCallExecutor({
    registry,
    projectRoot: workspace,
    allowBypassPermissions: allowBypass,
  });
}

test("new session defaults to projectDir=null and permission=chat-only", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const session = manager.getCurrentSession();

    assert.equal(session.projectDir, null);
    assert.equal(session.permission, "chat-only");
    assert.equal(session.projectBound, false);
    assert.deepEqual(session.allowedReadRoots, []);
    assert.deepEqual(session.allowedWriteRoots, []);
    assert.equal(session.commandCwd, null);
    assert.equal(session.displayName, undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("unbound session blocks file.read tool", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const session = manager.getCurrentSession();

    const request = createGatewayToolCallRequest({
      toolName: "file.read",
      input: { path: "some-file.ts" },
      sessionId: session.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(session),
    });

    const record = await executor.execute(request);
    assert.equal(record.status, "denied");
    assert.ok(
      record.error?.includes("未绑定 projectDir"),
      `Expected error about unbound projectDir, got: ${record.error}`
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("unbound session blocks shell.run tool", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const session = manager.getCurrentSession();

    const request = createGatewayToolCallRequest({
      toolName: "shell.run",
      input: { command: "echo hello" },
      sessionId: session.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(session),
    });

    const record = await executor.execute(request);
    assert.equal(record.status, "denied");
    assert.ok(
      record.error?.includes("未绑定 projectDir"),
      `Expected error about unbound projectDir, got: ${record.error}`
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bindProjectDir persists projectDir, permission, projectBound, displayName to session", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);

    const session = manager.getCurrentSession();
    assert.equal(session.projectDir, projectDir);
    assert.equal(session.permission, "project-write");
    assert.equal(session.projectBound, true);
    assert.equal(typeof session.projectBoundAt, "string");
    assert.equal(session.projectBindingSource, "repl");
    assert.ok(session.displayName?.includes("已绑定"), `displayName should contain "已绑定", got: ${session.displayName}`);
    assert.ok(session.displayName?.includes("test-project"), `displayName should include folder name, got: ${session.displayName}`);
    assert.deepEqual(session.allowedReadRoots, [projectDir]);
    assert.deepEqual(session.allowedWriteRoots, [projectDir]);
    assert.equal(session.commandCwd, projectDir);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bindProjectDir generates project-scan.json in sessionDir", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    const { scan } = manager.bindProjectDir(sessionId, projectDir, [workspace]);

    assert.equal(scan.projectDir, projectDir);
    assert.equal(typeof scan.scannedAt, "string");
    assert.equal(typeof scan.hasGit, "boolean");
    assert.equal(typeof scan.hasPackageJson, "boolean");
    assert.equal(scan.hasPackageJson, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("file tool cannot access paths outside projectDir", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);
    const session = manager.getCurrentSession();

    const outsidePath = path.join(workspace, "outside.txt");
    fs.writeFileSync(outsidePath, "secret", "utf8");

    const request = createGatewayToolCallRequest({
      toolName: "file.read",
      input: { path: outsidePath },
      sessionId: session.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(session),
    });

    const record = await executor.execute(request);
    assert.equal(record.status, "denied");
    assert.ok(
      record.error?.includes("不在允许读取") || record.error?.includes("path escapes workspace") || record.error?.includes("敏感") || record.error?.includes("sensitive"),
      `Expected error about path outside projectDir, got: ${record.error}`
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("file tool rejects relative path with ../ escape attempt", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);
    const session = manager.getCurrentSession();

    const request = createGatewayToolCallRequest({
      toolName: "file.read",
      input: { path: "../sessions.json" },
      sessionId: session.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(session),
    });

    const record = await executor.execute(request);
    assert.equal(record.status, "denied");
    assert.ok(
      record.error?.includes("逃出项目目录") || record.error?.includes("不在允许读取") || record.error?.includes("path escapes workspace"),
      `Expected error about path escape, got: ${record.error}`
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("builtin file.write uses bound projectDir for relative paths", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const projectDir = createTestProjectDir(workspace);
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: workspace,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: workspace,
      allowBypassPermissions: true,
    });
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);
    const session = manager.getCurrentSession();

    const request = createGatewayToolCallRequest({
      toolName: "file.write",
      input: { path: "src/generated.txt", content: "from bound project\n" },
      sessionId: session.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(session),
    });

    const record = await executor.execute(request);
    assert.equal(record.status, "success", `Expected success, got: ${record.error}`);
    assert.equal(
      fs.readFileSync(path.join(projectDir, "src", "generated.txt"), "utf8"),
      "from bound project\n"
    );
    assert.equal(fs.existsSync(path.join(workspace, "src", "generated.txt")), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bound project allows file.write in default permission mode", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const projectDir = createTestProjectDir(workspace);
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: workspace,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: workspace,
      allowBypassPermissions: true,
    });
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);
    const session = manager.getCurrentSession();

    const request = createGatewayToolCallRequest({
      toolName: "file.write",
      input: { path: "src/default-mode.txt", content: "allowed\n" },
      sessionId: session.id,
      permissionMode: "default",
      projectBoundary: extractProjectBoundary(session),
    });

    const record = await executor.execute(request);
    assert.equal(record.status, "success", `Expected success, got: ${record.error}`);
    assert.equal(
      fs.readFileSync(path.join(projectDir, "src", "default-mode.txt"), "utf8"),
      "allowed\n"
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("shell command cwd is forced to projectDir", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);
    const session = manager.getCurrentSession();

    const request = createGatewayToolCallRequest({
      toolName: "shell.run",
      input: {
        command: "node -e \"process.stdout.write(process.cwd())\"",
      },
      sessionId: session.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(session),
    });

    const record = await executor.execute(request);
    assert.ok(record.status === "ok" || record.status === "success", `Expected ok/success, got: ${record.status}`);

    const rawOutput = record.output?.content ?? record.result?.result ?? "";
    let cwdFromOutput: string;
    if (typeof rawOutput === "string") {
      try {
        const parsed = JSON.parse(rawOutput);
        cwdFromOutput = String(parsed.stdoutPreview ?? parsed.stdout ?? "").trim();
      } catch {
        cwdFromOutput = rawOutput.trim();
      }
    } else if (rawOutput && typeof rawOutput === "object") {
      cwdFromOutput = String(rawOutput.stdoutPreview ?? rawOutput.stdout ?? "").trim();
    } else {
      cwdFromOutput = String(rawOutput).trim();
    }
    const normalizedActual = path.resolve(cwdFromOutput).toLowerCase();
    const normalizedExpected = path.resolve(projectDir).toLowerCase();
    assert.equal(normalizedActual, normalizedExpected);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("binding agent-rebuild itself restricts write to workspace/", async () => {
  const agentRebuildRoot = path.resolve("D:\\WorkStation\\agent-rebuild");

  if (!fs.existsSync(path.join(agentRebuildRoot, "package.json"))) {
    return;
  }

  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, agentRebuildRoot, [agentRebuildRoot]);
    const session = manager.getCurrentSession();

    const workspaceFilePath = path.join(agentRebuildRoot, "workspace", "test-write.txt");

    const request = createGatewayToolCallRequest({
      toolName: "file.write",
      input: { path: workspaceFilePath, content: "test" },
      sessionId: session.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(session),
    });

    const record = await executor.execute(request);
    assert.equal(record.status, "denied");
    assert.ok(
      record.error?.includes("不在允许写入的目录范围内"),
      `Expected error about workspace write restriction, got: ${record.error}`
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("devTaskState and projectDir binding coexist in session", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.setCurrentSessionDevTaskState({
      status: "completed",
      fixRounds: 3,
      lastTestOk: true,
      startedAt: new Date().toISOString(),
    });

    manager.bindProjectDir(sessionId, projectDir, [workspace]);

    const session = manager.getCurrentSession();
    assert.equal(session.projectDir, projectDir);
    assert.equal(session.permission, "project-write");
    assert.ok(session.devTaskState, "devTaskState should still exist");
    assert.equal(session.devTaskState?.status, "completed");
    assert.equal(session.devTaskState?.fixRounds, 3);
    assert.equal(session.devTaskState?.lastTestOk, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("reload session restores projectDir, permission, projectBound, displayName, and devTaskState", () => {
  const workspace = createTempWorkspace();
  try {
    const store = new SessionStore();
    const manager1 = new SessionManager(store);
    manager1.createSession("Reload Test");
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager1.getCurrentSessionId();

    manager1.setCurrentSessionDevTaskState({
      status: "running",
      fixRounds: 1,
      lastTestOk: false,
      startedAt: new Date().toISOString(),
    });

    manager1.bindProjectDir(sessionId, projectDir, [workspace]);

    const manager2 = new SessionManager(store);
    manager2.switchSession(sessionId);
    const reloaded = manager2.getCurrentSession();

    assert.equal(reloaded.projectDir, projectDir);
    assert.equal(reloaded.permission, "project-write");
    assert.equal(reloaded.projectBound, true);
    assert.equal(typeof reloaded.projectBoundAt, "string");
    assert.equal(reloaded.projectBindingSource, "repl");
    assert.ok(reloaded.displayName?.includes("已绑定"));
    assert.deepEqual(reloaded.allowedReadRoots, [projectDir]);
    assert.deepEqual(reloaded.allowedWriteRoots, [projectDir]);
    assert.equal(reloaded.commandCwd, projectDir);
    assert.ok(reloaded.devTaskState, "devTaskState should survive reload");
    assert.equal(reloaded.devTaskState?.status, "running");
    assert.equal(reloaded.devTaskState?.fixRounds, 1);
    assert.equal(reloaded.devTaskState?.lastTestOk, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bindProjectDir rejects non-existent path under allowed root", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const nonExistent = path.join(workspace, "non-existent-subdir");
    assert.throws(
      () => manager.bindProjectDir(sessionId, nonExistent, [workspace]),
      /does not exist/
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bindProjectDir rejects system directories", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    assert.throws(
      () => manager.bindProjectDir(sessionId, "C:\\Windows", [workspace]),
      /forbidden segment|Refused/
    );

    assert.throws(
      () => manager.bindProjectDir(sessionId, "C:\\Users", [workspace]),
      /forbidden segment|Refused/
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bindProjectDir allows existing non-system path outside configured roots", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const outsideDir = path.join(workspace, "..", "outside-root-test");
    const resolvedOutside = path.resolve(outsideDir);
    fs.mkdirSync(resolvedOutside, { recursive: true });

    const { session } = manager.bindProjectDir(sessionId, resolvedOutside, [workspace]);
    assert.equal(session.projectDir, resolvedOutside);
    assert.equal(session.projectBound, true);

    fs.rmSync(resolvedOutside, { recursive: true, force: true });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bindProjectDir scans package.json and detects test/build commands", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        name: "test-proj",
        scripts: { test: "vitest", build: "tsc" },
      }),
      "utf8"
    );

    const { scan } = manager.bindProjectDir(sessionId, projectDir, [workspace]);

    assert.equal(scan.hasPackageJson, true);
    assert.equal(scan.possibleTestCommand, "npm test");
    assert.equal(scan.possibleBuildCommand, "npm run build");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("allowedWriteRoots supports directory + single file mix", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    const pkgPath = path.join(projectDir, "package.json");
    fs.writeFileSync(pkgPath, '{"name":"test"}', "utf8");
    const tsconfigPath = path.join(projectDir, "tsconfig.json");
    fs.writeFileSync(tsconfigPath, '{}', "utf8");

    const session = manager.getCurrentSession();
    manager.sessionStore.setProjectBinding(sessionId, {
      projectDir,
      permission: "project-write",
      allowedReadRoots: [projectDir],
      allowedWriteRoots: [
        path.join(projectDir, "src"),
        path.join(projectDir, "package.json"),
        path.join(projectDir, "tsconfig.json"),
      ],
      commandCwd: projectDir,
    });
    const updatedSession = manager.getCurrentSession();

    const srcRequest = createGatewayToolCallRequest({
      toolName: "file.write",
      input: { path: path.join(projectDir, "src", "new.ts"), content: "export {};" },
      sessionId: updatedSession.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(updatedSession),
    });
    const srcRecord = await executor.execute(srcRequest);
    assert.notEqual(srcRecord.status, "denied", `src/ write should NOT be denied by boundary, got: ${srcRecord.error}`);

    const pkgRequest = createGatewayToolCallRequest({
      toolName: "file.write",
      input: { path: pkgPath, content: '{"name":"updated"}' },
      sessionId: updatedSession.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(updatedSession),
    });
    const pkgRecord = await executor.execute(pkgRequest);
    assert.notEqual(pkgRecord.status, "denied", `package.json write should NOT be denied by boundary, got: ${pkgRecord.error}`);

    const lockPath = path.join(projectDir, "package-lock.json");
    fs.writeFileSync(lockPath, '{}', "utf8");
    const lockRequest = createGatewayToolCallRequest({
      toolName: "file.write",
      input: { path: lockPath, content: '{}' },
      sessionId: updatedSession.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(updatedSession),
    });
    const lockRecord = await executor.execute(lockRequest);
    assert.equal(lockRecord.status, "denied", "package-lock.json write should be denied");

    const readmePath = path.join(projectDir, "README.md");
    fs.writeFileSync(readmePath, '# test', "utf8");
    const readmeRequest = createGatewayToolCallRequest({
      toolName: "file.write",
      input: { path: readmePath, content: '# updated' },
      sessionId: updatedSession.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(updatedSession),
    });
    const readmeRecord = await executor.execute(readmeRequest);
    assert.equal(readmeRecord.status, "denied", "README.md write should be denied (not in allowedWriteRoots)");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("new-session creates new session then binds (not current session)", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const projectDir = createTestProjectDir(workspace);

    const originalSessionId = manager.getCurrentSessionId();

    const created = manager.createSession();
    assert.notEqual(created.id, originalSessionId, "new session should have different id");

    manager.bindProjectDir(created.id, projectDir, [workspace]);

    const currentSession = manager.getCurrentSession();
    assert.equal(currentSession.id, created.id);
    assert.equal(currentSession.projectDir, projectDir);
    assert.equal(currentSession.permission, "project-write");
    assert.equal(currentSession.projectBound, true);

    manager.switchSession(originalSessionId);
    const originalSession = manager.getCurrentSession();
    assert.equal(originalSession.projectDir, null);
    assert.equal(originalSession.permission, "chat-only");
    assert.equal(originalSession.projectBound, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("re-bind same path is idempotent (no error, no re-scan)", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    const first = manager.bindProjectDir(sessionId, projectDir, [workspace]);
    assert.equal(first.session.projectBound, true);

    const second = manager.bindProjectDir(sessionId, projectDir, [workspace]);
    assert.equal(second.session.projectBound, true);
    assert.equal(second.session.projectDir, projectDir);
    assert.equal(second.session.permission, "project-write");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("bind different path returns PROJECT_DIR_CONFLICT", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const projectDir1 = createTestProjectDir(workspace, "project-1");
    const projectDir2 = createTestProjectDir(workspace, "project-2");
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir1, [workspace]);

    try {
      manager.bindProjectDir(sessionId, projectDir2, [workspace]);
      assert.fail("Should have thrown PROJECT_DIR_CONFLICT");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const conflict = JSON.parse(message);
      assert.equal(conflict.code, "PROJECT_DIR_CONFLICT");
      assert.equal(conflict.existingProjectDir, projectDir1);
      assert.ok(conflict.requestedProjectDir.includes("project-2"));
      assert.ok(conflict.suggestion.includes(":new"));
    }

    const session = manager.getCurrentSession();
    assert.equal(session.projectDir, projectDir1, "original projectDir should be unchanged");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("SessionStore with defaultAllowedRoots includes whitelisted directories in new sessions", () => {
  const workspace = createTempWorkspace();
  try {
    const store = new SessionStore({
      snapshotPath: path.join(workspace, "sessions.json"),
      defaultAllowedReadRoots: ["/whitelist/read-a", "/whitelist/read-b"],
      defaultAllowedWriteRoots: ["/whitelist/write-a"],
      defaultPermission: "project-write",
    });

    const session = store.createSession({ name: "Whitelist Test" });

    assert.equal(session.permission, "project-write");
    assert.deepEqual(session.allowedReadRoots, ["/whitelist/read-a", "/whitelist/read-b"]);
    assert.deepEqual(session.allowedWriteRoots, ["/whitelist/write-a"]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("SessionStore without options preserves original chat-only defaults", () => {
  const workspace = createTempWorkspace();
  try {
    const store = new SessionStore(path.join(workspace, "sessions.json"));
    const session = store.createSession({ name: "Default Test" });

    assert.equal(session.permission, "chat-only");
    assert.deepEqual(session.allowedReadRoots, []);
    assert.deepEqual(session.allowedWriteRoots, []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("shell blocks dangerous commands: cd .., rm -rf, del /s", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);
    const session = manager.getCurrentSession();

    const dangerousCommands = [
      "cd ..",
      "cd \\",
      "cd D:\\other",
      "rm -rf /tmp/test",
      "del /s /q *.txt",
      "rmdir /s /q folder",
      "format C:",
      "powershell -EncodedCommand abc",
    ];

    for (const command of dangerousCommands) {
      const request = createGatewayToolCallRequest({
        toolName: "shell.run",
        input: { command },
        sessionId: session.id,
        permissionMode: "bypassPermissions",
        projectBoundary: extractProjectBoundary(session),
      });

      const record = await executor.execute(request);
      assert.equal(record.status, "denied", `Expected "${command}" to be denied, got: ${record.status}`);
      assert.ok(
        record.error?.includes("危险操作"),
        `Expected dangerous command error for "${command}", got: ${record.error}`
      );
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("shell allows safe commands after bind", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);
    const session = manager.getCurrentSession();

    const request = createGatewayToolCallRequest({
      toolName: "shell.run",
      input: { command: "echo hello-world" },
      sessionId: session.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(session),
    });

    const record = await executor.execute(request);
    assert.ok(record.status === "ok" || record.status === "success", `Safe echo should succeed, got: ${record.status}`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("read-only tool can read external safe path outside projectDir", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);
    const session = manager.getCurrentSession();

    const externalDir = path.join("D:\\WorkStation", `agent-ext-test-${Date.now()}`);
    fs.mkdirSync(externalDir, { recursive: true });
    const externalFile = path.join(externalDir, "external-doc.txt");
    fs.writeFileSync(externalFile, "external content", "utf8");

    try {
      const request = createGatewayToolCallRequest({
        toolName: "file.read",
        input: { path: externalFile },
        sessionId: session.id,
        permissionMode: "bypassPermissions",
        projectBoundary: extractProjectBoundary(session),
      });

      const record = await executor.execute(request);
      assert.notEqual(record.status, "denied", `Read-only access to safe external path should NOT be denied, got: ${record.error}`);
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("write tool cannot write to external path outside allowedWriteRoots", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);
    const session = manager.getCurrentSession();

    const externalFile = path.join(workspace, "external-doc.txt");
    fs.writeFileSync(externalFile, "original", "utf8");

    const request = createGatewayToolCallRequest({
      toolName: "file.write",
      input: { path: externalFile, content: "hacked" },
      sessionId: session.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(session),
    });

    const record = await executor.execute(request);
    assert.equal(record.status, "denied", "Write to external path should be denied");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("read-only tool cannot read .ssh or sensitive paths", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);
    const session = manager.getCurrentSession();

    const sensitivePaths = [
      "C:\\Users\\test\\.ssh\\id_rsa",
      "C:\\Users\\test\\AppData\\Local\\secret",
      "C:\\Windows\\System32\\config\\SAM",
    ];

    for (const sensitivePath of sensitivePaths) {
      const request = createGatewayToolCallRequest({
        toolName: "file.read",
        input: { path: sensitivePath },
        sessionId: session.id,
        permissionMode: "bypassPermissions",
        projectBoundary: extractProjectBoundary(session),
      });

      const record = await executor.execute(request);
      assert.equal(record.status, "denied", `Read of sensitive path ${sensitivePath} should be denied`);
      assert.ok(
        record.error?.includes("sensitive") || record.error?.includes("敏感") || record.error?.includes("不在允许读取"),
        `Expected sensitive path error for ${sensitivePath}, got: ${record.error}`
      );
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("shell cannot cd to another project via command", async () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const executor = createToolCallExecutor(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);
    const session = manager.getCurrentSession();

    const request = createGatewayToolCallRequest({
      toolName: "shell.run",
      input: { command: `cd ${workspace}` },
      sessionId: session.id,
      permissionMode: "bypassPermissions",
      projectBoundary: extractProjectBoundary(session),
    });

    const record = await executor.execute(request);
    assert.equal(record.status, "denied", "shell cd to workspace root should be blocked");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("devTaskState and projectBound coexist and persist together", () => {
  const workspace = createTempWorkspace();
  try {
    const store = new SessionStore();
    const manager = new SessionManager(store);
    manager.createSession("DevTask Test");
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.setCurrentSessionDevTaskState({
      status: "running",
      fixRounds: 2,
      lastTestOk: true,
      startedAt: new Date().toISOString(),
    });

    manager.bindProjectDir(sessionId, projectDir, [workspace]);

    const session = manager.getCurrentSession();
    assert.equal(session.projectBound, true);
    assert.equal(session.projectDir, projectDir);
    assert.ok(session.devTaskState);
    assert.equal(session.devTaskState.status, "running");
    assert.equal(session.devTaskState.fixRounds, 2);

    const manager2 = new SessionManager(store);
    manager2.switchSession(sessionId);
    const reloaded = manager2.getCurrentSession();

    assert.equal(reloaded.projectBound, true);
    assert.equal(reloaded.projectDir, projectDir);
    assert.ok(reloaded.devTaskState);
    assert.equal(reloaded.devTaskState.status, "running");
    assert.equal(reloaded.devTaskState.fixRounds, 2);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("summarizeSession writes daily memory file with session summary", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const summary = manager.summarizeSession(sessionId);

    const today = new Date().toISOString().slice(0, 10);
    const memoryPath = path.join(workspace, "memory", `${today}.md`);

    if (summary !== null) {
      assert.ok(summary.includes("Session Summary"), "summary should contain session header");
      assert.ok(summary.includes(sessionId), "summary should contain sessionId");
      assert.ok(fs.existsSync(memoryPath), "daily memory file should be created");
    }

    assert.ok(true, "summarizeSession should not throw");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
