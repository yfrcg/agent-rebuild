import test from "node:test";
import assert from "node:assert/strict";

import { loadGatewayConfig } from "../packages/gateway/config";

test("loadGatewayConfig supports mock model, sandbox, and session auto compaction settings", () => {
  const config = loadGatewayConfig({
    GATEWAY_MODEL: "mock",
    GATEWAY_MEMORY_TOP_K: "7",
    GATEWAY_SANDBOX_MODE: "read-only",
    GATEWAY_SANDBOX_ALLOWED_ROOTS: "workspace,config",
    GATEWAY_CONFIRM_TOKEN_TTL_MS: "90000",
    GATEWAY_SESSION_AUTO_COMPACT_ENABLED: "false",
    GATEWAY_SESSION_AUTO_COMPACT_MAX_ENTRIES: "42",
  } as NodeJS.ProcessEnv);

  assert.equal(config.model, "mock");
  assert.equal(config.memoryTopK, 7);
  assert.equal(config.sandboxMode, "read-only");
  assert.deepEqual(config.sandboxAllowedRoots, [
    "D:\\WorkStation\\agent-rebuild",
    "D:\\WorkStation\\agent-rebuild\\workspace",
    "D:\\WorkStation\\agent-rebuild\\config",
  ]);
  assert.equal(config.confirmTokenTtlMs, 90000);
  assert.equal(config.sessionAutoCompactEnabled, false);
  assert.equal(config.sessionAutoCompactMaxEntries, 42);
});

test("loadGatewayConfig supports sandbox backend overrides", () => {
  const config = loadGatewayConfig({
    GATEWAY_SANDBOX_BACKEND: "docker",
    GATEWAY_SANDBOX_IMAGE: "agentrebuild-sandbox:test",
    GATEWAY_SANDBOX_MAX_STDOUT_BYTES: "4096",
  } as NodeJS.ProcessEnv);

  assert.equal(config.sandbox.backend, "docker");
  assert.equal(config.sandbox.dockerImage, "agentrebuild-sandbox:test");
  assert.equal(config.sandbox.maxStdoutBytes, 4096);
});

test("loadGatewayConfig maps SANDBOX_MODE=wsl to remote backend and windows root", () => {
  const config = loadGatewayConfig({
    SANDBOX_MODE: "wsl",
    WINDOWS_PROJECT_ROOT: "D:\\WorkStation\\agent-rebuild",
  } as NodeJS.ProcessEnv);

  assert.equal(config.sandbox.backend, "remote");
  assert.equal(config.sandboxAllowedRoots[0], "D:\\WorkStation\\agent-rebuild");
  assert.equal(
    config.sandboxAllowedRoots[1],
    "D:\\WorkStation\\agent-rebuild\\workspace"
  );
});
