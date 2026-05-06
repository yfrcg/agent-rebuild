
import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateWsUpgrade,
  loadGatewayWsAuthConfig,
} from "../packages/gateway/ws/auth";

test("ws auth allows connection without token config", () => {
  const config = loadGatewayWsAuthConfig({});
  const result = authenticateWsUpgrade({
    url: "/v1/ws",
    headers: { origin: "http://localhost:3000" },
    config,
  });
  assert.deepEqual(result, { ok: true });
});

test("ws auth rejects missing token when token is configured", () => {
  const config = loadGatewayWsAuthConfig({ GATEWAY_WS_TOKEN: "secret123" });
  const result = authenticateWsUpgrade({
    url: "/v1/ws",
    headers: { origin: "http://localhost:3000" },
    config,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "UNAUTHORIZED");
  }
});

test("ws auth accepts query token", () => {
  const config = loadGatewayWsAuthConfig({ GATEWAY_WS_TOKEN: "secret123" });
  const result = authenticateWsUpgrade({
    url: "/v1/ws?token=secret123",
    headers: { origin: "http://localhost:3000" },
    config,
  });
  assert.deepEqual(result, { ok: true });
});

test("ws auth accepts Authorization Bearer token", () => {
  const config = loadGatewayWsAuthConfig({ GATEWAY_WS_TOKEN: "secret123" });
  const result = authenticateWsUpgrade({
    url: "/v1/ws",
    headers: {
      origin: "http://localhost:3000",
      authorization: "Bearer secret123",
    },
    config,
  });
  assert.deepEqual(result, { ok: true });
});

test("ws auth rejects disallowed origin", () => {
  const config = loadGatewayWsAuthConfig({
    GATEWAY_WS_ALLOWED_ORIGINS: "http://localhost:3000",
  });
  const result = authenticateWsUpgrade({
    url: "/v1/ws",
    headers: { origin: "http://evil.example" },
    config,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "FORBIDDEN");
  }
});

test("ws auth rejects empty origin when origins are explicitly configured", () => {
  const config = loadGatewayWsAuthConfig({
    GATEWAY_WS_ALLOWED_ORIGINS: "http://localhost:3000",
  });
  const result = authenticateWsUpgrade({
    url: "/v1/ws",
    headers: {},
    config,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "FORBIDDEN");
  }
});

test("ws auth warns for short tokens without printing the token", () => {
  const previousWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    const config = loadGatewayWsAuthConfig({ GATEWAY_WS_TOKEN: "abc123" });

    assert.equal(config.token, "abc123");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /shorter than 8 characters/);
    assert.equal((warnings[0] ?? "").includes("abc123"), false);
  } finally {
    console.warn = previousWarn;
  }
});
