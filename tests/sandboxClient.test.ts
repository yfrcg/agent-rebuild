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
