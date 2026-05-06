
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { parseGatewayCommand } from "../packages/gateway/commandParser";
import { createBuiltinToolRegistry } from "../packages/gateway/builtinTools";
import { handleBuiltInGatewayCommand } from "../packages/gateway/replCommandHandlers";
import { SessionManager } from "../packages/gateway/sessionManager";
import { SessionStore } from "../packages/gateway/sessionStore";
import type { GatewayToolCallRequest, GatewayToolCallRecord } from "../packages/gateway/toolCallTypes";

test("repl :tool shell.run route executes through ToolCallExecutor", async () => {
  await withTempWorkspace(async () => {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
    });
    const sessionManager = new SessionManager(
      new SessionStore(path.join(process.cwd(), "logs", "sessions.json"))
    );
    const captured: GatewayToolCallRequest[] = [];

    const result = await handleBuiltInGatewayCommand(parseGatewayCommand(':tool shell.run {"command":"node -v"}'), {
      sessionManager,
      toolRegistry: registry,
      toolCallExecutor: {
        /** 方法 `execute`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
        async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
          captured.push(request);
          return createLocalToolCallRecord(request);
        },
      } as unknown as never,
      memoryTopK: 5,
      sandbox: createReplSandboxDouble(),
      confirmTokenTtlMs: 300_000,
      rl: { close() {} } as never,
    });

    assert.equal(result.handled, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.toolName, "shell.run");
    assert.deepEqual(captured[0]?.input, {
      command: "node -v",
    });
  });
});

test("repl :sh shortcut maps to bash.run through ToolCallExecutor", async () => {
  await withTempWorkspace(async () => {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
    });
    const sessionManager = new SessionManager(
      new SessionStore(path.join(process.cwd(), "logs", "sessions.json"))
    );
    const captured: GatewayToolCallRequest[] = [];

    const result = await handleBuiltInGatewayCommand(parseGatewayCommand(":sh node -v"), {
      sessionManager,
      toolRegistry: registry,
      toolCallExecutor: {
        /** 方法 `execute`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
        async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
          captured.push(request);
          return createLocalToolCallRecord(request);
        },
      } as unknown as never,
      memoryTopK: 5,
      sandbox: createReplSandboxDouble(),
      confirmTokenTtlMs: 300_000,
      rl: { close() {} } as never,
    });

    assert.equal(result.handled, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.toolName, "bash.run");
    assert.deepEqual(captured[0]?.input, {
      command: "node -v",
    });
  });
});

test("repl read-file command routes through ToolCallExecutor", async () => {
  await withTempWorkspace(async () => {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
    });
    const sessionManager = new SessionManager(
      new SessionStore(path.join(process.cwd(), "logs", "sessions.json"))
    );
    const captured: GatewayToolCallRequest[] = [];

    const result = await handleBuiltInGatewayCommand(
      {
        type: "read-file",
        raw: "读文件 README.md",
        payload: "README.md",
      },
      {
        sessionManager,
        toolRegistry: registry,
        toolCallExecutor: {
          /** 方法 `execute`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
          async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
            captured.push(request);
            return createLocalToolCallRecord(request);
          },
        } as unknown as never,
        memoryTopK: 5,
        sandbox: createReplSandboxDouble(),
        confirmTokenTtlMs: 300_000,
        rl: { close() {} } as never,
      }
    );

    assert.equal(result.handled, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.toolName, "file.read");
    assert.deepEqual(captured[0]?.input, {
      path: "README.md",
    });
  });
});

test("repl :plan commands toggle plan mode and approval state", async () => {
  await withTempWorkspace(async () => {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
    });
    const sessionManager = new SessionManager(
      new SessionStore(path.join(process.cwd(), "logs", "sessions.json"))
    );

    const planOn = await handleBuiltInGatewayCommand(parseGatewayCommand(":plan on"), {
      sessionManager,
      toolRegistry: registry,
      toolCallExecutor: {
        /** 方法 `execute`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
        async execute() {
          throw new Error("should not execute tools");
        },
      } as unknown as never,
      memoryTopK: 5,
      sandbox: createReplSandboxDouble(),
      confirmTokenTtlMs: 300_000,
      rl: { close() {} } as never,
    });

    assert.equal(planOn.handled, true);
    assert.equal(sessionManager.getCurrentSession().permissionMode, "plan");
    assert.equal(sessionManager.getCurrentSession().planState?.active, true);

    const planApprove = await handleBuiltInGatewayCommand(
      parseGatewayCommand(":plan approve"),
      {
        sessionManager,
        toolRegistry: registry,
        toolCallExecutor: {
          /** 方法 `execute`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
          async execute() {
            throw new Error("should not execute tools");
          },
        } as unknown as never,
        memoryTopK: 5,
        sandbox: createReplSandboxDouble(),
        confirmTokenTtlMs: 300_000,
        rl: { close() {} } as never,
      }
    );

    assert.equal(planApprove.handled, true);
    assert.equal(sessionManager.getCurrentSession().permissionMode, "default");
    assert.equal(sessionManager.getCurrentSession().planState?.status, "approved");
    assert.equal(sessionManager.getCurrentSession().planState?.active, false);
  });
});

/**
 * 函数 `createLocalToolCallRecord` 的职责说明。
 * `createLocalToolCallRecord` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createLocalToolCallRecord(
  request: GatewayToolCallRequest
): GatewayToolCallRecord {
  return {
    id: request.id,
    toolName: request.toolName,
    input: request.input,
    status: "success",
    createdAt: request.createdAt,
    durationMs: 1,
    output: {
      ok: true,
      content: {
        decision: "local",
        stdout: "v20.20.2",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        artifacts: [],
      },
      metadata: {
        durationMs: 1,
        runner: "local-windows",
      },
    },
  };
}

/**
 * 函数 `createReplSandboxDouble` 的职责说明。
 * `createReplSandboxDouble` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createReplSandboxDouble() {
  return {
    mode: "off",
    allowedRoots: [process.cwd()],
    /** 方法 `canExecuteTool`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    canExecuteTool() {
      return { allowed: true };
    },
    /** 方法 `canUseToolInputPaths`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    canUseToolInputPaths() {
      return { allowed: true };
    },
    /** 方法 `requiresConfirmation`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    requiresConfirmation() {
      return false;
    },
    /** 方法 `canWriteMemory`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    canWriteMemory() {
      return { allowed: true };
    },
    /** 方法 `getToolSecurityProfile`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    getToolSecurityProfile() {
      return undefined;
    },
  } as never;
}

/**
 * 函数 `withTempWorkspace` 的职责说明。
 * `withTempWorkspace` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function withTempWorkspace(run: () => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-repl-"));
  const previousCwd = process.cwd();
  const originalConsoleLog = console.log;
  console.log = () => undefined;

  try {
    process.chdir(tempDir);
    await run();
  } finally {
    console.log = originalConsoleLog;
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}
