import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { normalizeSandboxWorkerRunRequest } from "../packages/sandbox/src/server";

test("sandbox worker normalizes timeout, envAllowlist, networkPolicy, and resourceLimits", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-worker-"));

  try {
    const request = normalizeSandboxWorkerRunRequest(
      {
        command: "npm test",
        workspaceMount: tempDir,
        cwd: tempDir,
        timeoutMs: 45_000,
        env: {
          CI: "true",
          SECRET_TOKEN: "nope",
        },
        envAllowlist: ["CI", "NODE_ENV"],
        networkPolicy: "disabled",
        resourceLimits: {
          memoryMb: 512,
          cpus: 1.5,
          pidsLimit: 64,
          maxOutputBytes: 32768,
        },
      },
      {
        allowedRoot: tempDir,
      }
    );

    assert.equal(request.command, "npm test");
    assert.equal(request.workspaceMount, tempDir);
    assert.equal(request.cwd, tempDir);
    assert.equal(request.timeoutMs, 45_000);
    assert.deepEqual(request.envAllowlist, ["CI", "NODE_ENV"]);
    assert.equal(request.networkPolicy, "disabled");
    assert.deepEqual(request.resourceLimits, {
      memoryMb: 512,
      cpus: 1.5,
      pidsLimit: 64,
      maxOutputBytes: 32768,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("sandbox worker rejects cwd outside workspaceMount", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-worker-root-"));
  const workspaceDir = await mkdtemp(path.join(rootDir, "workspace-"));

  try {
    await assert.throws(
      () =>
        normalizeSandboxWorkerRunRequest(
          {
            command: "npm test",
            workspaceMount: workspaceDir,
            cwd: path.resolve(workspaceDir, ".."),
          },
          {
            allowedRoot: rootDir,
          }
        ),
      /path escapes workspace/i
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("sandbox worker rejects missing workspaceMount", async () => {
  assert.throws(
    () =>
      normalizeSandboxWorkerRunRequest({
        command: "npm test",
      }),
    /workspaceMount is required/i
  );
});

test("sandbox worker rejects nonexistent workspaceMount", async () => {
  const missingDir = path.join(os.tmpdir(), `agent-rebuild-worker-missing-${Date.now()}`);

  assert.throws(
    () =>
      normalizeSandboxWorkerRunRequest(
        {
          command: "npm test",
          workspaceMount: missingDir,
        },
        {
          allowedRoot: os.tmpdir(),
        }
      ),
    /workspaceMount does not exist/i
  );
});
