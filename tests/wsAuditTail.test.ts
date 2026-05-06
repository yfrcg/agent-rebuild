
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { readAuditTail } from "../packages/gateway/ws/auditTail";

test("audit.tail reads recent JSONL entries with redaction", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ws-audit-"));
  try {
    const filePath = path.join(dir, "audit.jsonl");
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: "ws.connected", token: "secret" }),
        "bad json",
        JSON.stringify({ type: "ws.request.received", sessionId: "s1" }),
      ].join("\n"),
      "utf8"
    );

    const result = readAuditTail(filePath, { limit: 10 });
    assert.equal(result.length, 2);
    assert.equal((result[0] as Record<string, unknown>).token, "[REDACTED]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
