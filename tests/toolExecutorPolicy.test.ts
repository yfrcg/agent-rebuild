import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createGatewayToolCallRequest } from "../packages/gateway/toolCallFactory";
import { createBuiltinToolRegistry } from "../packages/gateway/builtinTools";
import { ToolCallExecutor } from "../packages/gateway/toolCallExecutor";
import { ToolRegistry } from "../packages/gateway/toolRegistry";
import { createSandboxedBashTool } from "../packages/gateway/tools/sandboxedBash";
import type { GatewayTool } from "../packages/gateway/toolTypes";

test("tool executor blocks write tools in plan mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-tool-"));

  try {
    const registry = new ToolRegistry();
    registry.register(createHostWriteTool(tempDir));
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.write",
        input: {
          path: "notes.txt",
          content: "next plan draft",
        },
        sessionId: "plan-session",
        permissionMode: "plan",
        planState: {
          active: true,
          status: "draft",
        },
      })
    );

    assert.equal(record.status, "denied");
    assert.match(record.error ?? "", /plan mode/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tool executor blocks shell execution in plan mode", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "shell.run",
    description: "Run one shell command",
    permissionLevel: "execute",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    riskLevel: "dangerous",
    async execute() {
      return {
        toolCallId: "",
        ok: true,
        result: {
          stdout: "should not run",
        },
      };
    },
  });

  const executor = new ToolCallExecutor({
    registry,
  });

  const record = await executor.execute(
    createGatewayToolCallRequest({
      toolName: "shell.run",
      input: {
        command: "npm test",
      },
      permissionMode: "plan",
      planState: {
        active: true,
        status: "draft",
      },
      approved: true,
    })
  );

  assert.equal(record.status, "denied");
  assert.match(record.error ?? "", /plan mode/i);
});

test("tool executor blocks npm_test in plan mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-plan-npm-test-"));

  try {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "npm_test",
        input: {},
        permissionMode: "plan",
        planState: {
          active: true,
          status: "draft",
        },
      })
    );

    assert.equal(record.status, "denied");
    assert.match(record.error ?? "", /plan mode/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file mutations require a prior read", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-read-before-edit-"));

  try {
    fs.writeFileSync(path.join(tempDir, "draft.txt"), "alpha\n", "utf8");
    const registry = new ToolRegistry();
    registry.register(createHostReadTool(tempDir));
    registry.register(createHostWriteTool(tempDir));
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.write",
        input: {
          path: "draft.txt",
          content: "beta\n",
        },
        sessionId: "edit-session",
        permissionMode: "acceptEdits",
      })
    );

    assert.equal(record.status, "error");
    assert.match(record.error ?? "", /read this file before editing/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file mutations reject stale reads when mtime/hash changed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-stale-read-"));

  try {
    const targetPath = path.join(tempDir, "draft.txt");
    fs.writeFileSync(targetPath, "alpha\n", "utf8");

    const registry = new ToolRegistry();
    registry.register(createHostReadTool(tempDir));
    registry.register(createHostWriteTool(tempDir));
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const readRecord = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.read",
        input: {
          path: "draft.txt",
        },
        sessionId: "edit-session",
      })
    );

    assert.equal(readRecord.status, "success");
    fs.writeFileSync(targetPath, "alpha changed elsewhere\n", "utf8");

    const writeRecord = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.write",
        input: {
          path: "draft.txt",
          content: "beta\n",
        },
        sessionId: "edit-session",
        permissionMode: "acceptEdits",
      })
    );

    assert.equal(writeRecord.status, "error");
    assert.match(writeRecord.error ?? "", /re-read/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file mutations include diff summary metadata after a successful write", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-diff-summary-"));

  try {
    fs.writeFileSync(path.join(tempDir, "draft.txt"), "alpha\n", "utf8");
    const registry = new ToolRegistry();
    registry.register(createHostReadTool(tempDir));
    registry.register(createHostWriteTool(tempDir));
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const readRecord = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.read",
        input: {
          path: "draft.txt",
        },
        sessionId: "edit-session",
      })
    );
    assert.equal(readRecord.status, "success");

    const writeRecord = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "file.write",
        input: {
          path: "draft.txt",
          content: "beta\n",
        },
        sessionId: "edit-session",
        permissionMode: "acceptEdits",
      })
    );

    assert.equal(writeRecord.status, "success");
    assert.match(
      JSON.stringify(writeRecord.output?.metadata ?? {}),
      /diffSummary/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("shell.run is denied when sandbox is unavailable and the tool requires sandbox", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-shell-deny-"));

  try {
    const registry = new ToolRegistry();
    registry.register(createSandboxedBashTool(tempDir, "shell.run"));
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "shell.run",
        input: {
          command: "npm test",
        },
        approved: true,
      })
    );

    assert.equal(record.status, "denied");
    assert.match(
      record.error ?? "",
      /Sandbox unavailable: refusing to execute command on host|requires sandbox/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("npm_test is denied when sandbox is unavailable and host fallback is disabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-npm-test-deny-"));

  try {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "npm_test",
        input: {},
        approved: true,
      })
    );

    assert.equal(record.status, "denied");
    assert.match(record.error ?? "", /Sandbox unavailable: refusing to execute command on host/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("build is denied when sandbox is unavailable and host fallback is disabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-build-deny-"));

  try {
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc -b" } }, null, 2),
      "utf8"
    );
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "build",
        input: {},
        approved: true,
      })
    );

    assert.equal(record.status, "denied");
    assert.match(record.error ?? "", /Sandbox unavailable: refusing to execute command on host/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("execution tools reject cwd outside the workspace", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-cwd-boundary-"));

  try {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "npm_test",
        input: {
          cwd: "C:\\outside\\workspace",
        },
        approved: true,
      })
    );

    assert.equal(record.status, "denied");
    assert.match(record.error ?? "", /path escapes workspace/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("execution tool non-zero exitCode returns structured failure instead of throwing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-execution-failure-"));

  try {
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
      sandbox: createExecutionSandboxStub({
        ok: false,
        exitCode: 2,
        stdout: "running tests\n",
        stderr: "2 failing specs\n",
        durationMs: 55,
      }),
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "npm_test",
        input: {},
        approved: true,
      })
    );

    assert.equal(record.status, "error");
    assert.equal(record.result?.ok, false);
    assert.equal(
      (record.result?.result as Record<string, unknown>)?.exitCode,
      2
    );
    assert.match(
      String((record.result?.result as Record<string, unknown>)?.stderrPreview ?? ""),
      /2 failing specs/i
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("large execution output is truncated into logs/tool-results", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-large-exec-output-"));
  const previousCwd = process.cwd();

  try {
    process.chdir(tempDir);
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
      sandbox: createExecutionSandboxStub({
        ok: true,
        exitCode: 0,
        stdout: "x".repeat(9_000),
        stderr: "",
        durationMs: 88,
      }),
    });

    const record = await executor.execute(
      createGatewayToolCallRequest({
        toolName: "run_test",
        input: {},
        approved: true,
      })
    );

    assert.equal(record.status, "success");
    const summary = record.result?.result as Record<string, unknown>;
    const fullOutputPath = String(summary.fullOutputPath ?? "");
    assert.ok(fullOutputPath);
    assert.equal(fs.existsSync(fullOutputPath), true);
  } finally {
    process.chdir(previousCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("execution tool audit log includes key sandbox metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-exec-audit-"));

  try {
    const events: unknown[] = [];
    const registry = createBuiltinToolRegistry({
      memorySearch: async () => [],
      projectRoot: tempDir,
    });
    const executor = new ToolCallExecutor({
      registry,
      projectRoot: tempDir,
      auditLogger: {
        log(event: unknown) {
          events.push(event);
        },
      },
      sandbox: createExecutionSandboxStub({
        ok: true,
        exitCode: 0,
        stdout: "ok\n",
        stderr: "",
        durationMs: 42,
        timedOut: true,
        artifacts: [
          {
            path: path.join(tempDir, "artifacts", "report.txt"),
            sizeBytes: 10,
            kind: "txt",
          },
        ],
      }),
    });

    await executor.execute(
      createGatewayToolCallRequest({
        toolName: "npm_test",
        input: {
          cwd: tempDir,
        },
        approved: true,
      })
    );

    assert.equal(events.length, 1);
    const event = events[0] as Record<string, unknown>;
    assert.equal(event.toolName, "npm_test");
    assert.equal(event.sandboxed, true);
    assert.equal(event.exitCode, 0);
    assert.equal(event.status, "success");
    assert.equal(event.timedOut, true);
    assert.deepEqual(event.artifacts, [
      {
        path: path.join(tempDir, "artifacts", "report.txt"),
        sizeBytes: 10,
        kind: "txt",
        description: undefined,
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function createHostReadTool(projectRoot: string): GatewayTool {
  return {
    name: "file.read",
    description: "Read one workspace file",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    riskLevel: "safe",
    async execute(input) {
      const filePath = path.resolve(projectRoot, String((input as Record<string, unknown>).path));
      return {
        toolCallId: "",
        ok: true,
        result: fs.readFileSync(filePath, "utf8"),
      };
    },
  };
}

function createHostWriteTool(projectRoot: string): GatewayTool {
  return {
    name: "file.write",
    description: "Write one workspace file",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    riskLevel: "medium",
    async execute(input) {
      const args = input as Record<string, unknown>;
      const filePath = path.resolve(projectRoot, String(args.path));
      fs.writeFileSync(filePath, String(args.content ?? ""), "utf8");
      return {
        toolCallId: "",
        ok: true,
        result: {
          path: filePath,
        },
      };
    },
  };
}

function createExecutionSandboxStub(input: {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  artifacts?: Array<{
    path: string;
    sizeBytes?: number;
    kind?: string;
    description?: string;
  }>;
}) {
  return {
    canUseToolInputPaths() {
      return { allowed: true };
    },
    canExecuteTool() {
      return { allowed: true };
    },
    getToolSecurityProfile(tool: GatewayTool | undefined) {
      return tool?.security;
    },
    manager: {
      async exec() {
        return {
          ...input,
          timedOut: input.timedOut ?? false,
          artifacts: input.artifacts ?? [],
        };
      },
    },
  } as never;
}
