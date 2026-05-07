
import test from "node:test";
import assert from "node:assert/strict";

import { loadGatewayConfig } from "../packages/gateway/config";

test("loadGatewayConfig supports mock model, sandbox mode, and session auto compaction settings", () => {
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

test("loadGatewayConfig supports MiniMax TokenPlan model aliases", () => {
  const tokenPlan = loadGatewayConfig({
    GATEWAY_MODEL: "tokenplan",
  } as NodeJS.ProcessEnv);
  const miniMax = loadGatewayConfig({
    GATEWAY_MODEL: "minimax",
  } as NodeJS.ProcessEnv);

  assert.equal(tokenPlan.model, "tokenplan");
  assert.equal(miniMax.model, "tokenplan");
});
