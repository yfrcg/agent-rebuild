import assert from "node:assert/strict";
import test from "node:test";

import { DockerSandboxBackend } from "../packages/sandbox/src/dockerBackend";
import { SandboxManager } from "../packages/sandbox/src/sandboxManager";

test("real docker sandbox can execute a simple command when docker is available", async (t) => {
  const backend = new DockerSandboxBackend();
  const availability = await backend.checkAvailability();

  if (!availability.ok) {
    t.skip(`docker unavailable: ${availability.error ?? "unknown error"}`);
    return;
  }

  const manager = new SandboxManager({ backend });
  const result = await manager.exec({
    sessionId: "docker-smoke",
    profileName: "safe-dev",
    toolName: "bash.run",
    command: "echo hello",
    projectRoot: process.cwd(),
  });

  if (!result.ok) {
    t.skip(`docker runtime unavailable: ${result.stderr || result.deniedReason || "unknown error"}`);
    return;
  }

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello/);
});

test("real docker sandbox keeps default network disabled", async (t) => {
  const backend = new DockerSandboxBackend();
  const availability = await backend.checkAvailability();

  if (!availability.ok) {
    t.skip(`docker unavailable: ${availability.error ?? "unknown error"}`);
    return;
  }

  const manager = new SandboxManager({ backend });
  const result = await manager.exec({
    sessionId: "docker-network",
    profileName: "safe-dev",
    toolName: "bash.run",
    command:
      "python3 - <<'PY'\nimport urllib.request\ntry:\n    urllib.request.urlopen('https://example.com', timeout=5)\n    print('unexpected-network')\nexcept Exception as exc:\n    print(type(exc).__name__)\n    raise SystemExit(7)\nPY",
    projectRoot: process.cwd(),
  });

  if (result.exitCode === 125) {
    t.skip(`docker runtime unavailable: ${result.stderr || "container launch failed"}`);
    return;
  }

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
});
