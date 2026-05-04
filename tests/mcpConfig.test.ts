import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadGatewayMcpServerConfigs, getMcpConfigSources } from "../packages/gateway/mcpConfig";

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

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const existed = fs.existsSync(configPath);
  const backup = existed ? fs.readFileSync(configPath, "utf8") : "";

  try {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        servers: [
          {
            id: "test-server",
            name: "Test Server",
            enabled: false,
            transport: "stdio",
            command: "echo",
          },
        ],
      }),
      "utf8"
    );

    const configs = loadGatewayMcpServerConfigs();
    const found = configs.find((c) => c.id === "test-server");
    assert.ok(found, "should find test-server in loaded configs");
    assert.equal(found?.name, "Test Server");
    assert.equal(found?.enabled, false);
    assert.equal(found?.transport, "stdio");
  } finally {
    if (existed) {
      fs.writeFileSync(configPath, backup, "utf8");
    } else {
      fs.unlinkSync(configPath);
    }
  }
});
