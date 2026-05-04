import assert from "node:assert/strict";
import test from "node:test";

import { WslSandboxClient } from "../packages/sandbox-client/src";

test("wsl sandbox client returns structured error on non-2xx response", async () => {
  const client = new WslSandboxClient({
    apiKey: "test-key",
    fetchImpl: async () =>
      new Response("forbidden", {
        status: 403,
      }),
  });

  const result = await client.run({
    command: "npm test",
    windowsCwd: "D:\\WorkStation\\agent-rebuild",
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /HTTP 403/i);
});

test("wsl sandbox client returns structured error when api key is missing", async () => {
  const client = new WslSandboxClient({
    apiKey: "",
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });

  const result = await client.run({
    command: "npm test",
    windowsCwd: "D:\\WorkStation\\agent-rebuild",
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /SANDBOX_API_KEY/i);
});

test("wsl sandbox client parses timedOut and artifacts from worker response", async () => {
  const client = new WslSandboxClient({
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.equal(payload.workspaceMount, "D:\\WorkStation\\agent-rebuild");
      assert.equal(payload.cwd, "D:\\WorkStation\\agent-rebuild");
      assert.deepEqual(payload.envAllowlist, ["CI", "NODE_ENV"]);
      return new Response(
        JSON.stringify({
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "timed out",
          durationMs: 1234,
          timedOut: true,
          artifacts: [
            {
              path: "/workspace/artifacts/report.txt",
              sizeBytes: 42,
              kind: "txt",
              description: "test report",
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      );
    },
  });

  const result = await client.run({
    command: "npm test",
    cwd: "D:\\WorkStation\\agent-rebuild",
    workspaceMount: "D:\\WorkStation\\agent-rebuild",
    envAllowlist: ["CI", "NODE_ENV"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.durationMs, 1234);
  assert.deepEqual(result.artifacts, [
    {
      path: "/workspace/artifacts/report.txt",
      sizeBytes: 42,
      kind: "txt",
      description: "test report",
    },
  ]);
});
