import assert from "node:assert/strict";
import test from "node:test";

import { SandboxManager } from "../packages/sandbox/src/manager";
import { DockerSandboxProvider } from "../packages/sandbox/src/providers/dockerProvider";

test("real docker sandbox exec runs only when docker daemon is available", async (t) => {
  const provider = new DockerSandboxProvider();
  const availability = await provider.checkAvailability();

  if (!availability.ok) {
    t.skip(`docker unavailable: ${availability.error ?? "unknown error"}`);
    return;
  }

  const manager = new SandboxManager({
    config: {
      backend: "docker",
      requireRuntime: true,
    },
    runtimeProvider: provider,
  });

  const result = await manager.exec({
    sessionId: "real-docker-test",
    toolCallId: `real-docker-${Date.now()}`,
    toolName: "sandbox.exec",
    command: "sh",
    args: ["-lc", "node -v"],
    cwd: process.cwd(),
    riskLevel: "high",
  });

  assert.equal(result.decision, "sandbox");
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^v\d+/);
});
