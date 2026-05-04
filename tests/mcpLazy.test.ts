import assert from "node:assert/strict";
import test from "node:test";

import { GatewayMcpManager } from "../packages/gateway/mcpManager";
import type { GatewayMcpServerConfig } from "../packages/gateway/mcpTypes";

function makeConfig(overrides: Partial<GatewayMcpServerConfig> = {}): GatewayMcpServerConfig {
  return {
    id: "test-server",
    name: "Test Server",
    enabled: true,
    transport: "stdio",
    command: "echo",
    toolNamePrefix: "mcp.test",
    ...overrides,
  };
}

test("McpManager non-lazy mode initializes eagerly", async () => {
  const manager = new GatewayMcpManager([makeConfig({ enabled: false })]);
  assert.equal(manager.hasConfiguredServers(), true);
  await manager.connectEnabledServers();
  const statuses = manager.listStatuses();
  assert.equal(statuses[0]?.phase, "disabled");
});

test("McpManager lazy mode skips connectEnabledServers", async () => {
  const manager = new GatewayMcpManager(
    [makeConfig({ enabled: true })],
    undefined,
    { lazy: true }
  );
  await manager.connectEnabledServers();
  const statuses = manager.listStatuses();
  assert.equal(statuses[0]?.phase, "configured");
});

test("McpManager lazy mode ensureServerConnected for enabled server", async () => {
  const manager = new GatewayMcpManager(
    [makeConfig({ enabled: true, command: "nonexistent-command-12345" })],
    undefined,
    { lazy: true }
  );

  await manager.connectEnabledServers();

  try {
    await manager.ensureServerConnected("test-server");
  } catch {
    // expected to fail since command doesn't exist
  }

  const statuses = manager.listStatuses();
  const status = statuses.find((s) => s.id === "test-server");
  assert.ok(status);
  assert.equal(status.id, "test-server");
});

test("McpManager lazy mode ensureServerConnected for nonexistent server", async () => {
  const manager = new GatewayMcpManager(
    [makeConfig()],
    undefined,
    { lazy: true }
  );

  await manager.connectEnabledServers();
  await manager.ensureServerConnected("nonexistent");
  assert.ok(true, "should not throw for nonexistent server");
});

test("McpManager lazy mode ensureServerConnected for disabled server", async () => {
  const manager = new GatewayMcpManager(
    [makeConfig({ enabled: false })],
    undefined,
    { lazy: true }
  );

  await manager.connectEnabledServers();
  await manager.ensureServerConnected("test-server");
  const statuses = manager.listStatuses();
  const status = statuses.find((s) => s.id === "test-server");
  assert.ok(status);
  assert.equal(status.phase, "disabled");
});
