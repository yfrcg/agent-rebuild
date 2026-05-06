
import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets } from "../packages/gateway/ws/redaction";

test("ws redaction removes sensitive object fields", () => {
  const redacted = redactSecrets({
    token: "abc",
    nested: { authorization: "Bearer secret", ok: true },
  });

  assert.deepEqual(redacted, {
    token: "[REDACTED]",
    nested: { authorization: "[REDACTED]", ok: true },
  });
});

test("ws redaction masks bearer tokens in strings", () => {
  assert.equal(
    redactSecrets("Authorization: Bearer abc.def.ghi"),
    "Authorization: Bearer [REDACTED]"
  );
});

test("ws redaction removes password and private key fields", () => {
  const redacted = redactSecrets({
    password: "p@ss",
    privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  });

  assert.equal(redacted.password, "[REDACTED]");
  assert.equal(redacted.privateKey, "[REDACTED]");
});
