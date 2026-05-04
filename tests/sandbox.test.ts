import test from "node:test";
import assert from "node:assert/strict";

import { GatewaySandbox } from "../packages/gateway/sandbox";
import { createGatewayToolCallRequest } from "../packages/gateway/toolCallFactory";
import { ToolCallExecutor } from "../packages/gateway/toolCallExecutor";
import { ToolRegistry } from "../packages/gateway/toolRegistry";

test("workspace-write sandbox blocks stateful tools", async () => {
  const registry = new ToolRegistry();
  let invoked = false;

  registry.register({
    name: "mcp.example.deploy",
    description: "Deploy example app",
    permissionLevel: "execute",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    policy: {
      automationLevel: "confirm",
      riskLevel: "stateful",
    },
    async invoke() {
      invoked = true;
      return {
        ok: true,
      };
    },
  });

  const executor = new ToolCallExecutor({
    registry,
    sandbox: new GatewaySandbox("workspace-write", [process.cwd()]),
  });

  const record = await executor.execute(
    createGatewayToolCallRequest({
      toolName: "mcp.example.deploy",
      input: {},
      approved: true,
    })
  );

  assert.equal(invoked, false);
  assert.equal(record.status, "denied");
  assert.match(record.error ?? "", /sandbox/i);
});

test("read-only sandbox blocks memory writes", () => {
  const sandbox = new GatewaySandbox("read-only", [process.cwd()]);
  const decision = sandbox.canWriteMemory("remember");

  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /read-only sandbox/i);
});

test("sandbox blocks tool input paths outside allowed roots", async () => {
  const registry = new ToolRegistry();
  let invoked = false;

  registry.register({
    name: "mcp.example.read_file",
    description: "Read one file path",
    policy: {
      automationLevel: "auto",
      riskLevel: "external-read",
    },
    async invoke() {
      invoked = true;
      return {
        ok: true,
      };
    },
  });

  const executor = new ToolCallExecutor({
    registry,
    sandbox: new GatewaySandbox("workspace-write", [process.cwd()]),
  });

  const record = await executor.execute(
    createGatewayToolCallRequest({
      toolName: "mcp.example.read_file",
      input: {
        filePath: "C:\\outside\\secret.txt",
      },
    })
  );

  assert.equal(invoked, false);
  assert.equal(record.status, "denied");
  assert.match(record.error ?? "", /(outside allowed roots|path escapes workspace)/i);
});

test("sandbox marks confirm and manual tools as requiring confirmation", () => {
  const sandbox = new GatewaySandbox("workspace-write", [process.cwd()]);

  assert.equal(
    sandbox.requiresConfirmation({
      name: "mcp.example.confirm",
      description: "confirm tool",
      policy: {
        automationLevel: "confirm",
        riskLevel: "stateful",
      },
      async invoke() {
        return { ok: true };
      },
    }),
    true
  );

  assert.equal(
    sandbox.requiresConfirmation({
      name: "mcp.example.manual",
      description: "manual tool",
      policy: {
        automationLevel: "manual",
        riskLevel: "external-read",
      },
      async invoke() {
        return { ok: true };
      },
    }),
    true
  );
});

test("sandbox requires restricted isolation for MCP servers when enabled", () => {
  const sandbox = new GatewaySandbox("workspace-write", [process.cwd()]);

  const blocked = sandbox.canConnectMcpServer({
    id: "example",
    name: "Example",
    enabled: true,
    transport: "stdio",
    command: "python",
    isolation: {
      enabled: false,
      mode: "inherit",
    },
  });

  assert.equal(blocked.allowed, false);

  const allowed = sandbox.canConnectMcpServer({
    id: "example",
    name: "Example",
    enabled: true,
    transport: "stdio",
    command: "python",
    isolation: {
      enabled: true,
      mode: "restricted",
      runtimeRoot: "workspace\\sandbox\\mcp\\example",
    },
  });

  assert.equal(allowed.allowed, true);
});
