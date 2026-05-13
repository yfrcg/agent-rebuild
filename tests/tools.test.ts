import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe } from "node:test";

import { createBuiltinToolRegistry } from "../packages/gateway/builtinTools";
import { parseGatewayCommand } from "../packages/gateway/commandParser";
import { handleBuiltInGatewayCommand } from "../packages/gateway/replCommandHandlers";
import { SessionManager } from "../packages/gateway/sessionManager";
import { SessionStore } from "../packages/gateway/sessionStore";
import type { GatewayToolCallRequest, GatewayToolCallRecord } from "../packages/gateway/toolCallTypes";

describe("tool policy", () => {
  test("memory.search is marked as safe auto-read", () => {
    const registry = createBuiltinToolRegistry({ memorySearch: async () => [] });
    const tool = registry.get("memory.search");
    assert.ok(tool);
    assert.equal(tool?.policy?.automationLevel, "auto");
    assert.equal(tool?.policy?.riskLevel, "read-only");
    assert.equal(tool?.security?.riskLevel, "safe");
    const listed = registry.list().find((item) => item.name === "memory.search");
    assert.equal(listed?.policy?.automationLevel, "auto");
  });

  test("bash.run allows local host execution", () => {
    const registry = createBuiltinToolRegistry({ memorySearch: async () => [] });
    const tool = registry.get("bash.run");
    assert.ok(tool);
    assert.equal(tool?.security?.riskLevel, "medium");
    assert.equal(tool?.security?.sandboxRequired, false);
    assert.equal(tool?.security?.allowHostExecution, true);
    assert.equal(typeof tool?.sandboxSpec?.resolve, "function");
  });

  test("file.read allows local host execution", () => {
    const registry = createBuiltinToolRegistry({ memorySearch: async () => [] });
    const tool = registry.get("file.read");
    assert.ok(tool);
    assert.equal(tool?.policy?.riskLevel, "read-only");
    assert.equal(tool?.security?.sandboxRequired, false);
    assert.equal(tool?.security?.allowHostExecution, true);
  });

  test("execution tools allow local host execution", () => {
    const registry = createBuiltinToolRegistry({ memorySearch: async () => [] });
    for (const toolName of ["run_test", "npm_test", "build"] as const) {
      const tool = registry.get(toolName);
      assert.ok(tool, `${toolName} should be registered`);
      assert.equal(tool?.permissionLevel, "execute");
      assert.equal(tool?.requiresSandbox, false);
    }
  });
});

describe("command parser", () => {
  test("parses compact command", () => {
    const parsed = parseGatewayCommand("compact");
    assert.equal(parsed.type, "compact");
    assert.equal(parsed.raw, "compact");
  });

  test("keeps remember payload trimmed", () => {
    const parsed = parseGatewayCommand("记住：  需要索引到今天的日记忆  ");
    assert.equal(parsed.type, "remember");
    assert.equal(parsed.payload, "需要索引到今天的日记忆");
  });

  test("parses skills command", () => {
    const parsed = parseGatewayCommand(":skills show gateway-maintainer");
    assert.equal(parsed.type, "skills");
    assert.equal(parsed.payload, "show gateway-maintainer");
  });

  test("parses natural language use skill command", () => {
    const parsed = parseGatewayCommand("use skill gateway-maintainer");
    assert.equal(parsed.type, "skills");
    assert.equal(parsed.payload, "use gateway-maintainer");
  });

  test("parses confirm command", () => {
    const parsed = parseGatewayCommand(":confirm approve_123");
    assert.equal(parsed.type, "confirm");
    assert.equal(parsed.payload, "approve_123");
  });

  test("parses approvals command", () => {
    const parsed = parseGatewayCommand(":approvals clear");
    assert.equal(parsed.type, "approvals");
    assert.equal(parsed.payload, "clear");
  });

  test("parses reject command", () => {
    const parsed = parseGatewayCommand(":reject approve_123");
    assert.equal(parsed.type, "reject");
    assert.equal(parsed.payload, "approve_123");
  });

  test("keeps sandbox.exec tool payload intact", () => {
    const parsed = parseGatewayCommand(':tool sandbox.exec {"command":"node -v"}');
    assert.equal(parsed.type, "tool");
    assert.equal(parsed.payload, 'sandbox.exec {"command":"node -v"}');
  });

  test("parses sandbox shortcut as sh alias", () => {
    const parsed = parseGatewayCommand(":sandbox node -v");
    assert.equal(parsed.type, "sh");
    assert.equal(parsed.payload, "node -v");
  });

  test("parses sh shortcut command", () => {
    const parsed = parseGatewayCommand(":sh npm test");
    assert.equal(parsed.type, "sh");
    assert.equal(parsed.payload, "npm test");
  });

  test("parses /name as skills invoke", () => {
    const parsed = parseGatewayCommand("/commit");
    assert.equal(parsed.type, "skills");
    assert.equal(parsed.payload, "invoke commit");
  });

  test("parses /name with args", () => {
    const parsed = parseGatewayCommand("/review fix auth.ts");
    assert.equal(parsed.type, "skills");
    assert.equal(parsed.payload, "invoke review fix auth.ts");
  });

  test("parses /name with hyphens and slashes", () => {
    const parsed = parseGatewayCommand("/code-review");
    assert.equal(parsed.type, "skills");
    assert.equal(parsed.payload, "invoke code-review");
  });

  test("does not parse // as skill", () => {
    const parsed = parseGatewayCommand("//not-a-skill");
    assert.notEqual(parsed.type, "skills");
  });

  test("does not parse / with only special chars as skill", () => {
    const parsed = parseGatewayCommand("/!@#$");
    assert.notEqual(parsed.type, "skills");
  });
});

describe("repl command handlers", () => {
  test(":tool shell.run route executes through ToolCallExecutor", async () => {
    await withTempWorkspace(async () => {
      const registry = createBuiltinToolRegistry({ memorySearch: async () => [] });
      const sessionManager = new SessionManager(new SessionStore());
      const captured: GatewayToolCallRequest[] = [];
      const result = await handleBuiltInGatewayCommand(parseGatewayCommand(':tool shell.run {"command":"node -v"}'), {
        sessionManager, toolRegistry: registry,
        toolCallExecutor: { async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> { captured.push(request); return makeToolCallRecord(request); } } as unknown as never,
        memoryTopK: 5, sandbox: makeSandboxDouble(), confirmTokenTtlMs: 300_000, rl: { close() {} } as never,
      });
      assert.equal(result.handled, true);
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.toolName, "shell.run");
      assert.deepEqual(captured[0]?.input, { command: "node -v" });
    });
  });

  test(":sh shortcut maps to bash.run through ToolCallExecutor", async () => {
    await withTempWorkspace(async () => {
      const registry = createBuiltinToolRegistry({ memorySearch: async () => [] });
      const sessionManager = new SessionManager(new SessionStore());
      const captured: GatewayToolCallRequest[] = [];
      const result = await handleBuiltInGatewayCommand(parseGatewayCommand(":sh node -v"), {
        sessionManager, toolRegistry: registry,
        toolCallExecutor: { async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> { captured.push(request); return makeToolCallRecord(request); } } as unknown as never,
        memoryTopK: 5, sandbox: makeSandboxDouble(), confirmTokenTtlMs: 300_000, rl: { close() {} } as never,
      });
      assert.equal(result.handled, true);
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.toolName, "bash.run");
      assert.deepEqual(captured[0]?.input, { command: "node -v" });
    });
  });

  test("read-file command routes through ToolCallExecutor", async () => {
    await withTempWorkspace(async () => {
      const registry = createBuiltinToolRegistry({ memorySearch: async () => [] });
      const sessionManager = new SessionManager(new SessionStore());
      const captured: GatewayToolCallRequest[] = [];
      const result = await handleBuiltInGatewayCommand(
        { type: "read-file", raw: "读文件 README.md", payload: "README.md" },
        {
          sessionManager, toolRegistry: registry,
          toolCallExecutor: { async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> { captured.push(request); return makeToolCallRecord(request); } } as unknown as never,
          memoryTopK: 5, sandbox: makeSandboxDouble(), confirmTokenTtlMs: 300_000, rl: { close() {} } as never,
        }
      );
      assert.equal(result.handled, true);
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.toolName, "file.read");
      assert.deepEqual(captured[0]?.input, { path: "README.md" });
    });
  });

  test(":plan commands toggle plan mode and approval state", async () => {
    await withTempWorkspace(async () => {
      const registry = createBuiltinToolRegistry({ memorySearch: async () => [] });
      const sessionManager = new SessionManager(new SessionStore());
      const toolCallExecutor = { async execute() { throw new Error("should not execute tools"); } } as unknown as never;
      const opts = { sessionManager, toolRegistry: registry, toolCallExecutor, memoryTopK: 5, sandbox: makeSandboxDouble(), confirmTokenTtlMs: 300_000, rl: { close() {} } as never };
      const planOn = await handleBuiltInGatewayCommand(parseGatewayCommand(":plan on"), opts);
      assert.equal(planOn.handled, true);
      assert.equal(sessionManager.getCurrentSession().permissionMode, "plan");
      assert.equal(sessionManager.getCurrentSession().planState?.active, true);
      const planApprove = await handleBuiltInGatewayCommand(parseGatewayCommand(":plan approve"), opts);
      assert.equal(planApprove.handled, true);
      assert.equal(sessionManager.getCurrentSession().permissionMode, "default");
      assert.equal(sessionManager.getCurrentSession().planState?.status, "approved");
      assert.equal(sessionManager.getCurrentSession().planState?.active, false);
    });
  });
});

function makeToolCallRecord(request: GatewayToolCallRequest): GatewayToolCallRecord {
  return {
    id: request.id, toolName: request.toolName, input: request.input, status: "success", createdAt: request.createdAt, durationMs: 1,
    output: { ok: true, content: { decision: "local", stdout: "v20.20.2", stderr: "", exitCode: 0, timedOut: false, artifacts: [] }, metadata: { durationMs: 1, runner: "local-windows" } },
  };
}

function makeSandboxDouble() {
  return {
    mode: "off", allowedRoots: [process.cwd()],
    canExecuteTool() { return { allowed: true }; },
    canUseToolInputPaths() { return { allowed: true }; },
    requiresConfirmation() { return false; },
    canWriteMemory() { return { allowed: true }; },
    getToolSecurityProfile() { return undefined; },
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
