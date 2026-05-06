
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createGatewayToolCallRequest } from "../packages/gateway/toolCallFactory";
import { createBuiltinToolRegistry } from "../packages/gateway/builtinTools";
import { ToolCallExecutor } from "../packages/gateway/toolCallExecutor";
import { ToolRegistry } from "../packages/gateway/toolRegistry";
import { createSandboxedBashTool } from "../packages/gateway/tools/sandboxedBash";
import type { GatewayTool } from "../packages/gateway/toolTypes";

test("tool executor blocks write tools in plan mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-tool-"));

  try {
    const registry = new ToolRegistry();
    registry.register(createHostWriteTool(tempDir));
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.write",
        input: {
          path: "notes.txt",
          content: "next plan draft",
        },
        sessionId: "plan-session",
        permissionMode: "plan",
        planState: {
          active: true,
          status: "draft",
        },
      })
    );

    assert.equal(record.status, "denied");
    assert.match(record.error ?? "", /plan mode/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tool executor blocks shell execution in plan mode", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "shell.run",
    description: "Run one shell command",
    permissionLevel: "execute",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    riskLevel: "dangerous",
    /** 方法 `execute`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async execute() {
      return {
        toolCallId: "",
        ok: true,
        result: {
          stdout: "should not run",
        },
      };
    },
  });

  const executor = new ToolCallExecutor({
    registry,
  });

  const record = await executor.execute(
    createGatewayToolCallRequest({
      toolName: "shell.run",
      input: {
        command: "npm test",
      },
      permissionMode: "plan",
      planState: {
        active: true,
        status: "draft",
      },
      approved: true,
    })
  );

  assert.equal(record.status, "denied");
  assert.match(record.error ?? "", /plan mode/i);
});

test("tool executor blocks npm_test in plan mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-plan-npm-test-"));

  try {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "npm_test",
        input: {},
        permissionMode: "plan",
        planState: {
          active: true,
          status: "draft",
        },
      })
    );

    assert.equal(record.status, "denied");
    assert.match(record.error ?? "", /plan mode/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file mutations require a prior read", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-read-before-edit-"));

  try {
    fs.writeFileSync(path.join(tempDir, "draft.txt"), "alpha\n", "utf8");
    const registry = new ToolRegistry();
    registry.register(createHostReadTool(tempDir));
    registry.register(createHostWriteTool(tempDir));
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.write",
        input: {
          path: "draft.txt",
          content: "beta\n",
        },
        sessionId: "edit-session",
        permissionMode: "acceptEdits",
      })
    );

    assert.equal(record.status, "error");
    assert.match(record.error ?? "", /read this file before editing/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file mutations reject stale reads when mtime/hash changed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-stale-read-"));

  try {
    const targetPath = path.join(tempDir, "draft.txt");
    fs.writeFileSync(targetPath, "alpha\n", "utf8");

    const registry = new ToolRegistry();
    registry.register(createHostReadTool(tempDir));
    registry.register(createHostWriteTool(tempDir));
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const readRecord = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.read",
        input: {
          path: "draft.txt",
        },
        sessionId: "edit-session",
      })
    );

    assert.equal(readRecord.status, "success");
    fs.writeFileSync(targetPath, "alpha changed elsewhere\n", "utf8");

    const writeRecord = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.write",
        input: {
          path: "draft.txt",
          content: "beta\n",
        },
        sessionId: "edit-session",
        permissionMode: "acceptEdits",
      })
    );

    assert.equal(writeRecord.status, "error");
    assert.match(writeRecord.error ?? "", /re-read/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file mutations include diff summary metadata after a successful write", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-diff-summary-"));

  try {
    fs.writeFileSync(path.join(tempDir, "draft.txt"), "alpha\n", "utf8");
    const registry = new ToolRegistry();
    registry.register(createHostReadTool(tempDir));
    registry.register(createHostWriteTool(tempDir));
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const readRecord = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.read",
        input: {
          path: "draft.txt",
        },
        sessionId: "edit-session",
      })
    );
    assert.equal(readRecord.status, "success");

    const writeRecord = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.write",
        input: {
          path: "draft.txt",
          content: "beta\n",
        },
        sessionId: "edit-session",
        permissionMode: "acceptEdits",
      })
    );

    assert.equal(writeRecord.status, "success");
    assert.match(
      JSON.stringify(writeRecord.output?.metadata ?? {}),
      /diffSummary/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("shell.run executes locally when no sandbox is configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-shell-local-"));

  try {
    const registry = new ToolRegistry();
    registry.register(createSandboxedBashTool(tempDir, "shell.run"));
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "shell.run",
        input: {
          command: "echo hello",
        },
        approved: true,
      })
    );

    assert.equal(record.status, "success");
    assert.match(
      String((record.result?.result as Record<string, unknown>)?.stdoutPreview ?? ""),
      /hello/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("npm_test executes locally when no sandbox is configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-npm-test-local-"));

  try {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "npm_test",
        input: {},
        approved: true,
      })
    );

    assert.equal(record.status, "error");
    assert.match(record.error ?? "", /npm|test|exit code/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("build executes locally when no sandbox is configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-build-local-"));

  try {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "build",
        input: {},
        approved: true,
      })
    );

    assert.equal(record.status, "error");
    assert.match(record.error ?? "", /build|exit code/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("execution tools reject cwd outside the workspace", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-cwd-boundary-"));

  try {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "npm_test",
        input: {
          cwd: "C:\\outside\\workspace",
        },
        approved: true,
      })
    );

    assert.equal(record.status, "denied");
    assert.match(record.error ?? "", /path escapes workspace/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("execution tool non-zero exitCode returns structured failure instead of throwing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-execution-failure-"));

  try {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "shell.run",
        input: {
          command: "node -e \"process.exit(2)\"",
        },
        approved: true,
      })
    );

    assert.equal(record.status, "error");
    assert.equal(record.result?.ok, false);
    const result = record.result?.result as Record<string, unknown>;
    assert.ok(typeof result?.exitCode === "number");
    assert.ok(result?.exitCode !== 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("large execution output is truncated into logs/tool-results", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-large-exec-output-"));
  const previousCwd = process.cwd();

  try {
    process.chdir(tempDir);
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "shell.run",
        input: {
          command: "node -e \"console.log('x'.repeat(9000))\"",
        },
        approved: true,
      })
    );

    assert.equal(record.status, "success");
    const summary = record.result?.result as Record<string, unknown>;
    const fullOutputPath = String(summary.fullOutputPath ?? "");
    assert.ok(fullOutputPath);
    assert.equal(fs.existsSync(fullOutputPath), true);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("execution tool audit log includes runner=local-windows metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-exec-audit-"));

  try {
    const events: unknown[] = [];
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
      auditLogger: {
        /** 方法 `log`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
        log(event: unknown) {
          events.push(event);
        },
      },
    });

    await executor.execute(
      createGatewayToolCallRequest({
        toolName: "shell.run",
        input: {
          command: "echo ok",
          cwd: tempDir,
        },
        approved: true,
      })
    );

    assert.equal(events.length, 1);
    const event = events[0] as Record<string, unknown>;
    assert.equal(event.toolName, "shell.run");
    assert.equal(event.sandboxed, false);
    assert.equal(event.runner, "local-windows");
    assert.equal(event.status, "success");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/**
 * 函数 `createHostReadTool` 的职责说明。
 * `createHostReadTool` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createHostReadTool(projectRoot: string): GatewayTool {
  return {
    name: "file.read",
    description: "Read one workspace file",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    riskLevel: "safe",
    /** 方法 `execute`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async execute(input) {
      const filePath = path.resolve(projectRoot, String((input as Record<string, unknown>).path));
      return {
        toolCallId: "",
        ok: true,
        result: fs.readFileSync(filePath, "utf8"),
      };
    },
  };
}

/**
 * 函数 `createHostWriteTool` 的职责说明。
 * `createHostWriteTool` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createHostWriteTool(projectRoot: string): GatewayTool {
  return {
    name: "file.write",
    description: "Write one workspace file",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    riskLevel: "medium",
    /** 方法 `execute`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async execute(input) {
      const args = input as Record<string, unknown>;
      const filePath = path.resolve(projectRoot, String(args.path));
      fs.writeFileSync(filePath, String(args.content ?? ""), "utf8");
      return {
        toolCallId: "",
        ok: true,
        result: {
          path: filePath,
        },
      };
    },
  };
}
