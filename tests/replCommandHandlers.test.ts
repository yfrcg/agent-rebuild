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

test("repl :tool sandbox.exec route executes through ToolCallExecutor", async () => {
  await withTempWorkspace(async () => {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
    });
    const sessionManager = new SessionManager(
      new SessionStore(path.join(process.cwd(), "logs", "sessions.json"))
    );
    const captured: GatewayToolCallRequest[] = [];

    const result = await handleBuiltInGatewayCommand(parseGatewayCommand(':tool sandbox.exec {"command":"node -v"}'), {
      sessionManager,
      toolRegistry: registry,
      toolCallExecutor: {
        async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
          captured.push(request);
          return createSandboxToolCallRecord(request, "mock-sandbox");
        },
      } as unknown as never,
      memoryTopK: 5,
      sandbox: createReplSandboxDouble(),
      confirmTokenTtlMs: 300_000,
      rl: { close() {} } as never,
    });

    assert.equal(result.handled, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.toolName, "sandbox.exec");
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
        async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
          captured.push(request);
          return createSandboxToolCallRecord(request, "mock-sandbox");
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
          async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
            captured.push(request);
            return createSandboxToolCallRecord(request, "mock-sandbox");
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

function createSandboxToolCallRecord(
  request: GatewayToolCallRequest,
  decision: "sandbox" | "mock-sandbox"
): GatewayToolCallRecord {
  return {
    id: request.id,
    toolName: request.toolName,
    input: request.input,
    status: "succeeded",
    createdAt: request.createdAt,
    durationMs: 1,
    output: {
      ok: true,
      content: {
        decision,
        blockedReason: undefined,
        stdout:
          decision === "mock-sandbox"
            ? "[mock sandbox] no real container isolation"
            : "v20.20.2",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        artifacts: [],
      },
      metadata: {
        auditId: "audit-test",
        sandboxId: "sandbox-test",
        durationMs: 1,
      },
    },
  };
}

function createReplSandboxDouble() {
  return {
    mode: "off",
    allowedRoots: [process.cwd()],
    containerConfig: {
      backend: "mock",
      dockerImage: "agentrebuild-sandbox:latest",
      auditLogPath: path.join(process.cwd(), "logs", "sandbox-audit.jsonl"),
      profiles: {
        plan: {
          name: "plan",
          network: "none",
          workspaceAccess: "none",
          timeoutMs: 10000,
          memoryMb: 512,
          cpus: 1,
          pidsLimit: 64,
        },
        "safe-dev": {
          name: "safe-dev",
          network: "none",
          workspaceAccess: "rw",
          timeoutMs: 30000,
          memoryMb: 1024,
          cpus: 1,
          pidsLimit: 128,
        },
        elevated: {
          name: "elevated",
          network: "restricted",
          workspaceAccess: "rw",
          timeoutMs: 60000,
          memoryMb: 2048,
          cpus: 2,
          pidsLimit: 256,
          requireHumanApproval: true,
        },
      },
      maxStdoutBytes: 204800,
      maxStderrBytes: 204800,
    },
    manager: {
      exec() {
        throw new Error("repl command must use ToolCallExecutor instead of SandboxManager");
      },
    },
    canUseToolInputPaths() {
      return { allowed: true };
    },
    requiresConfirmation() {
      return false;
    },
    canWriteMemory() {
      return { allowed: true };
    },
    getToolSecurityProfile() {
      return undefined;
    },
  } as never;
}

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
