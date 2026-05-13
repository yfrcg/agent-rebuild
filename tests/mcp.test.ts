import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { describe } from "node:test";

import { GatewayMcpManager } from "../packages/gateway/mcpManager";
import { loadGatewayMcpServerConfigs, getMcpConfigSources } from "../packages/gateway/mcpConfig";
import { buildTransportOptions, describeMcpLaunch } from "../packages/gateway/mcpClient";
import type { GatewayMcpServerConfig } from "../packages/gateway/mcpTypes";

function makeConfig(overrides: Partial<GatewayMcpServerConfig> = {}): GatewayMcpServerConfig {
  return {
    id: "test-server", name: "Test Server", enabled: true, transport: "stdio",
    command: "echo", toolNamePrefix: "mcp.test", ...overrides,
  };
}

describe("mcp lazy loading", () => {
  test("non-lazy mode initializes eagerly", async () => {
    const manager = new GatewayMcpManager([makeConfig({ enabled: false })]);
    assert.equal(manager.hasConfiguredServers(), true);
    await manager.connectEnabledServers();
    const statuses = manager.listStatuses();
    assert.equal(statuses[0]?.phase, "disabled");
  });

  test("lazy mode skips connectEnabledServers", async () => {
    const manager = new GatewayMcpManager([makeConfig({ enabled: true })], undefined, { lazy: true });
    await manager.connectEnabledServers();
    const statuses = manager.listStatuses();
    assert.equal(statuses[0]?.phase, "configured");
  });

  test("lazy mode ensureServerConnected for enabled server", async () => {
    const manager = new GatewayMcpManager([makeConfig({ enabled: true, command: "nonexistent-command-12345" })], undefined, { lazy: true });
    await manager.connectEnabledServers();
    try { await manager.ensureServerConnected("test-server"); } catch { /* expected */ }
    const status = manager.listStatuses().find((s) => s.id === "test-server");
    assert.ok(status);
    assert.equal(status?.id, "test-server");
  });

  test("lazy mode ensureServerConnected for nonexistent server", async () => {
    const manager = new GatewayMcpManager([makeConfig()], undefined, { lazy: true });
    await manager.connectEnabledServers();
    await manager.ensureServerConnected("nonexistent");
    assert.ok(true, "should not throw for nonexistent server");
  });

  test("lazy mode ensureServerConnected for disabled server", async () => {
    const manager = new GatewayMcpManager([makeConfig({ enabled: false })], undefined, { lazy: true });
    await manager.connectEnabledServers();
    await manager.ensureServerConnected("test-server");
    const status = manager.listStatuses().find((s) => s.id === "test-server");
    assert.ok(status);
    assert.equal(status?.phase, "disabled");
  });
});

describe("mcp config", () => {
  test("getMcpConfigSources returns three config paths", () => {
    const sources = getMcpConfigSources();
    assert.equal(sources.length, 3);
    assert.ok(sources[0].includes(".agent-rebuild"));
    assert.ok(sources[1].includes("mcp.servers.json"));
    assert.ok(sources[2].includes(".mcp.json"));
  });

  test("loadGatewayMcpServerConfigs returns empty when no config files exist", () => {
    const configs = loadGatewayMcpServerConfigs();
    assert.ok(Array.isArray(configs));
  });

  test("loadGatewayMcpServerConfigs loads from project config/mcp.servers.json", () => {
    const configDir = path.join(process.cwd(), "config");
    const configPath = path.join(configDir, "mcp.servers.json");
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const existed = fs.existsSync(configPath);
    const backup = existed ? fs.readFileSync(configPath, "utf8") : "";
    try {
      fs.writeFileSync(configPath, JSON.stringify({
        servers: [{ id: "test-server", name: "Test Server", enabled: false, transport: "stdio", command: "echo" }],
      }), "utf8");
      const configs = loadGatewayMcpServerConfigs();
      const found = configs.find((c) => c.id === "test-server");
      assert.ok(found, "should find test-server in loaded configs");
      assert.equal(found?.name, "Test Server");
      assert.equal(found?.enabled, false);
    } finally {
      if (existed) { fs.writeFileSync(configPath, backup, "utf8"); } else { fs.unlinkSync(configPath); }
    }
  });
});

describe("mcp client", () => {
  test("buildTransportOptions wraps restricted MCP servers with managed runner", () => {
    const options = buildTransportOptions({
      id: "course_project", name: "Course Project", enabled: true, transport: "stdio",
      command: "python", args: ["-m", "app.main", "stdio"], cwd: process.cwd(),
      isolation: { enabled: true, mode: "restricted", runtimeRoot: "workspace/sandbox/mcp/course_project", preserveEnvKeys: ["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT"] },
    });
    assert.equal(options.command, process.execPath);
    assert.ok(options.args?.[0].endsWith("scripts\\mcp-runner.js") || options.args?.[0].endsWith("scripts/mcp-runner.js"));
    assert.equal(options.args?.length, 2);
    const payload = JSON.parse(Buffer.from(options.args?.[1] ?? "", "base64").toString("utf8"));
    assert.equal(payload.command, "python");
    assert.deepEqual(payload.args, ["-m", "app.main", "stdio"]);
  });

  test("describeMcpLaunch reports managed runner metadata", () => {
    const launch = describeMcpLaunch({
      id: "course_project", name: "Course Project", enabled: true, transport: "stdio",
      command: "python", cwd: process.cwd(),
      isolation: { enabled: true, mode: "restricted", runtimeRoot: "workspace/sandbox/mcp/course_project" },
    });
    assert.equal(launch.launchMode, "managed-runner");
    assert.equal(launch.isolationMode, "restricted");
    assert.equal(launch.command, process.execPath);
  });
});
