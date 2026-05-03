import assert from "node:assert/strict";
import test from "node:test";

import { buildTransportOptions, describeMcpLaunch } from "../packages/gateway/mcpClient";

test("buildTransportOptions wraps restricted MCP servers with managed runner", () => {
  const options = buildTransportOptions({
    id: "course_project",
    name: "Course Project",
    enabled: true,
    transport: "stdio",
    command: "python",
    args: ["-m", "app.main", "stdio"],
    cwd: process.cwd(),
    isolation: {
      enabled: true,
      mode: "restricted",
      runtimeRoot: "workspace/sandbox/mcp/course_project",
      preserveEnvKeys: ["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT"],
    },
  });

  assert.equal(options.command, process.execPath);
  assert.ok(options.args?.[0].endsWith("scripts\\mcp-runner.js") || options.args?.[0].endsWith("scripts/mcp-runner.js"));
  assert.equal(options.args?.length, 2);

  const payload = JSON.parse(Buffer.from(options.args?.[1] ?? "", "base64").toString("utf8")) as {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
  };

  assert.equal(payload.command, "python");
  assert.deepEqual(payload.args, ["-m", "app.main", "stdio"]);
  assert.equal(payload.cwd, process.cwd());
  assert.equal(payload.env?.HOME?.includes("workspace"), true);
});

test("describeMcpLaunch reports managed runner metadata", () => {
  const launch = describeMcpLaunch({
    id: "course_project",
    name: "Course Project",
    enabled: true,
    transport: "stdio",
    command: "python",
    cwd: process.cwd(),
    isolation: {
      enabled: true,
      mode: "restricted",
      runtimeRoot: "workspace/sandbox/mcp/course_project",
    },
  });

  assert.equal(launch.launchMode, "managed-runner");
  assert.equal(launch.isolationMode, "restricted");
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.runtimeRoot?.includes("workspace"), true);
});
