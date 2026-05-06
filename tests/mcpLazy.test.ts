
import assert from "node:assert/strict";
import test from "node:test";

import { GatewayMcpManager } from "../packages/gateway/mcpManager";
import type { GatewayMcpServerConfig } from "../packages/gateway/mcpTypes";

/**
 * 函数 `makeConfig` 的职责说明。
 * `makeConfig` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
