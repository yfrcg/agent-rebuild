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
  assert.equal(config.sandboxAllowedRoots.length, 2);
  assert.equal(config.confirmTokenTtlMs, 90000);
  assert.equal(config.sessionAutoCompactEnabled, false);
  assert.equal(config.sessionAutoCompactMaxEntries, 42);
});

test("loadGatewayConfig supports mock sandbox backend flags", () => {
  const config = loadGatewayConfig({
    GATEWAY_SANDBOX_BACKEND: "mock",
    GATEWAY_SANDBOX_MOCK: "true",
    GATEWAY_SANDBOX_REQUIRE_RUNTIME: "false",
  } as NodeJS.ProcessEnv);

  assert.equal(config.sandbox.backend, "mock");
  assert.equal(config.sandbox.mock.enabled, true);
  assert.equal(config.sandbox.requireRuntime, false);
});
