
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type WebSocket from "ws";

import type { GatewayRuntime } from "../packages/gateway/runtime";
import { closeDb } from "../packages/storage/src/db";
import { SessionManager } from "../packages/gateway/sessionManager";
import { SessionStore } from "../packages/gateway/sessionStore";
import type {
  GatewayToolCallRecord,
  GatewayToolCallRequest,
} from "../packages/gateway/toolCallTypes";
import { ConnectionManager } from "../packages/gateway/ws/connectionManager";
import { IdempotencyStore } from "../packages/gateway/ws/idempotencyStore";
import { handleWsRequest } from "../packages/gateway/ws/router";
import { RunManager } from "../packages/gateway/ws/runManager";
import type { WsRequest } from "../packages/gateway/ws/protocol";

test("ws router handles connect", async () => {
  await withRouter(async ({ client, context, socket }) => {
    const response = await handleWsRequest(client, req("connect"), context);

    assert.equal(response?.ok, true);
    assert.equal((response?.payload as Record<string, unknown>).clientId, client.clientId);
    assert.equal(socket.messages[0]?.event, "connected");
  });
});

test("ws router handles ping", async () => {
  await withRouter(async ({ client, context }) => {
    const response = await handleWsRequest(client, req("ping"), context);

    assert.equal(response?.ok, true);
    assert.equal((response?.payload as Record<string, unknown>).pong, true);
  });
});

test("ws router returns runtime status", async () => {
  await withRouter(async ({ client, context }) => {
    const response = await handleWsRequest(client, req("runtime.status"), context);
    const payload = response?.payload as Record<string, unknown>;

    assert.equal(response?.ok, true);
    assert.equal(payload.model, "mock");
    assert.equal(payload.toolCount, 1);
  });
});

test("ws router lists sessions", async () => {
  await withRouter(async ({ client, context }) => {
    const response = await handleWsRequest(client, req("session.list"), context);

    assert.equal(response?.ok, true);
    assert.equal(Array.isArray(response?.payload), true);
  });
});

test("ws router creates sessions", async () => {
  await withRouter(async ({ client, context }) => {
    const response = await handleWsRequest(
      client,
      req("session.create", { name: "Created" }),
      context
    );
    const payload = response?.payload as Record<string, unknown>;

    assert.equal(response?.ok, true);
    assert.equal(payload.name, "Created");
  });
});

test("ws router lists tools", async () => {
  await withRouter(async ({ client, context }) => {
    const response = await handleWsRequest(client, req("tool.list"), context);

    assert.equal(response?.ok, true);
    assert.deepEqual(response?.payload, [{ name: "echo" }]);
  });
});

test("ws router searches memory", async () => {
  await withRouter(async ({ client, context }) => {
    const response = await handleWsRequest(
      client,
      req("memory.search", { query: "websocket" }),
      context
    );

    assert.equal(response?.ok, true);
    assert.deepEqual(response?.payload, [
      { id: "m1", content: "memory:websocket", source: "test" },
    ]);
  });
});

test("ws router chat.send returns run id and emits lifecycle events", async () => {
  await withRouter(async ({ client, context, socket, sessionId }) => {
    const response = await handleWsRequest(
      client,
      req("chat.send", { sessionId, input: "hello" }, "idem-chat"),
      context
    );

    assert.equal(response?.ok, true);
    assert.equal(typeof (response?.payload as Record<string, unknown>).runId, "string");
    await waitFor(() => socket.messages.some((message) => message.event === "run.finished"));

    assert.equal(socket.messages.some((message) => message.event === "run.started"), true);
    assert.equal(socket.messages.some((message) => message.event === "chat.delta"), true);
    assert.equal(socket.messages.some((message) => message.event === "chat.completed"), true);
    assert.equal(socket.messages.some((message) => message.event === "run.finished"), true);
  });
});

test("ws router chat.cancel aborts a running gateway handle", async () => {
  await withRouter(async ({ client, context, socket, sessionId }) => {
    const send = await handleWsRequest(
      client,
      req("chat.send", { sessionId, input: "slow" }),
      context
    );
    const runId = String((send?.payload as Record<string, unknown>).runId);
    const cancel = await handleWsRequest(
      client,
      req("chat.cancel", { runId }),
      context
    );

    assert.equal(cancel?.ok, true);
    await waitFor(() => socket.messages.some((message) => message.event === "run.cancelled"));
  });
});

test("ws router chat.cancel returns conflict for completed runs", async () => {
  await withRouter(async ({ client, context, sessionId }) => {
    const run = context.runs.createRun({
      sessionId,
      requestId: "completed-request",
      clientId: client.clientId,
    });
    context.runs.finishRun(run.runId);

    const response = await handleWsRequest(
      client,
      req("chat.cancel", { runId: run.runId }),
      context
    );

    assert.equal(response?.ok, false);
    assert.equal(response?.error?.code, "CONFLICT");
  });
});

test("ws router tool.call executes through ToolCallExecutor", async () => {
  await withRouter(async ({ client, context, socket, sessionId, executedTools }) => {
    context.connections.subscribe(client.clientId, sessionId);
    const response = await handleWsRequest(
      client,
      req("tool.call", {
        sessionId,
        toolName: "echo",
        input: { text: "hi" },
      }),
      context
    );

    assert.equal(response?.ok, true);
    assert.equal(executedTools.length, 1);
    assert.equal(executedTools[0]?.toolName, "echo");
    assert.equal(socket.messages.some((message) => message.event === "tool.finished"), true);
  });
});

test("ws router tool.call returns structured tool errors", async () => {
  await withRouter(async ({ client, context, socket, sessionId }) => {
    context.connections.subscribe(client.clientId, sessionId);
    const response = await handleWsRequest(
      client,
      req("tool.call", {
        sessionId,
        toolName: "missing.tool",
        input: { text: "hi" },
      }),
      context
    );
    const record = response?.payload as GatewayToolCallRecord;

    assert.equal(response?.ok, true);
    assert.equal(record.status, "error");
    assert.equal(socket.messages.some((message) => message.event === "tool.failed"), true);
  });
});

test("ws router memory.write uses controlled writer", async () => {
  await withRouter(async ({ client, context, sessionId }) => {
    const response = await handleWsRequest(
      client,
      req("memory.write", {
        sessionId,
        content: "Remember that WS tests use controlled memory writes.",
        scope: "daily",
      }, "idem-memory"),
      context
    );
    const payload = response?.payload as Record<string, unknown>;

    assert.equal(response?.ok, true);
    assert.equal(payload.sessionId, sessionId);
    assert.equal(payload.scope, "daily");
  });
});

test("ws router approval methods use explicit sessionId", async () => {
  await withRouter(async ({ client, context, sessionId }) => {
    context.runtime.sessionManager.addCurrentSessionApproval({
      token: "tok-1",
      toolName: "echo",
      input: { text: "approved" },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      message: "approve echo",
    });

    const list = await handleWsRequest(
      client,
      req("approval.list", { sessionId }),
      context
    );
    assert.equal((list?.payload as unknown[]).length, 1);

    const confirm = await handleWsRequest(
      client,
      req("approval.confirm", { sessionId, token: "tok-1" }),
      context
    );
    assert.equal(confirm?.ok, true);
  });
});

test("ws router returns structured error for unsupported methods", async () => {
  await withRouter(async ({ client, context }) => {
    const response = await handleWsRequest(
      client,
      { type: "req", id: "bad-method", method: "missing.method" as WsRequest["method"] },
      context
    );

    assert.equal(response?.ok, false);
    assert.equal(response?.error?.code, "NOT_IMPLEMENTED");
  });
});

/**
 * 函数 `req` 的职责说明。
 * `req` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function req(
  method: WsRequest["method"],
  params?: unknown,
  idempotencyKey?: string
): WsRequest {
  return {
    type: "req",
    id: `req-${method}`,
    method,
    params,
    idempotencyKey,
  };
}

/**
 * 函数 `withRouter` 的职责说明。
 * `withRouter` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function withRouter(
  run: (input: {
    runtime: GatewayRuntime;
    context: Parameters<typeof handleWsRequest>[2];
    client: ReturnType<ConnectionManager["add"]>;
    socket: WebSocket & { messages: Array<Record<string, unknown>> };
    sessionId: string;
    executedTools: GatewayToolCallRequest[];
  }) => Promise<void>
): Promise<void> {
  await withTempWorkspace(async () => {
    const sessionManager = new SessionManager(
      new SessionStore(path.join(process.cwd(), "logs", "sessions.json"))
    );
    const sessionId = sessionManager.getCurrentSessionId();
    const executedTools: GatewayToolCallRequest[] = [];
    const runtime = createRuntimeDouble(sessionManager, executedTools);
    const connections = new ConnectionManager();
    const socket = createSocket();
    const client = connections.add(socket);
    const context = {
      runtime,
      connections,
      runs: new RunManager(),
      idempotency: new IdempotencyStore(),
    };

    await run({ runtime, context, client, socket, sessionId, executedTools });
  });
}

/**
 * 函数 `createRuntimeDouble` 的职责说明。
 * `createRuntimeDouble` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createRuntimeDouble(
  sessionManager: SessionManager,
  executedTools: GatewayToolCallRequest[]
): GatewayRuntime {
  return {
    projectRoot: process.cwd(),
    config: {
      model: "mock",
      memoryTopK: 5,
      auditLogPath: "logs/audit/test.jsonl",
      debug: false,
      sandboxMode: "off",
      sandboxAllowedRoots: [process.cwd()],
      confirmTokenTtlMs: 300_000,
      autoToolLoopEnabled: true,
      autoToolLoopMaxSteps: 5,
      devTaskMaxSteps: 15,
      devTaskMaxFixRounds: 3,
      sessionAutoCompactEnabled: false,
      sessionAutoCompactMaxEntries: 80,
      rateLimitMaxRequests: 30,
      rateLimitWindowMs: 60_000,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 30_000,
      sloMaxRtMs: 200,
      sloMaxErrorRate: 0.1,
      tavilyApiKey: "",
    },
    sessionManager,
    gateway: {
      /** 方法 `handle`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
      async handle(_request: unknown, options?: { signal?: AbortSignal; onEvent?: (event: { type: "chat.delta"; delta: string }) => void }) {
        await options?.onEvent?.({ type: "chat.delta", delta: "hello " });
        if (
          _request &&
          typeof _request === "object" &&
          "input" in _request &&
          String((_request as { input: unknown }).input).includes("slow")
        ) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 5_000);
            options?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("RUN_CANCELLED"));
            }, { once: true });
          });
        }
        return {
          id: "response-1",
          text: "hello from gateway",
          memoryUsed: [],
          toolCalls: [],
          createdAt: new Date().toISOString(),
        };
      },
    },
    modelProvider: {
      supportsStreaming: true,
    },
    memorySearch: async (query: string) => [
      { id: "m1", content: `memory:${query}`, source: "test" },
    ],
    toolRegistry: {
      /** 方法 `list`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
      list() {
        return [{ name: "echo" }];
      },
    },
    toolCallExecutor: {
      /** 方法 `execute`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
      async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
        executedTools.push(request);
        if (request.toolName !== "echo") {
          return {
            id: request.id,
            toolName: request.toolName,
            input: request.input,
            status: "error",
            sessionId: request.sessionId,
            requestId: request.requestId,
            createdAt: request.createdAt,
            error: "Tool not found",
          };
        }
        return {
          id: request.id,
          toolName: request.toolName,
          input: request.input,
          status: "success",
          sessionId: request.sessionId,
          requestId: request.requestId,
          createdAt: request.createdAt,
          output: { ok: true, content: { echoed: request.input } },
        };
      },
    },
    metricsCollector: {
      /** 方法 `snapshot`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
      snapshot() {
        return { totalRequests: 0 };
      },
    },
    sandbox: {},
    auditLogger: { async log() {} },
    mcpManager: { async close() {} },
    /** 方法 `close`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async close() {},
  } as unknown as GatewayRuntime;
}

/**
 * 函数 `createSocket` 的职责说明。
 * `createSocket` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createSocket(): WebSocket & { messages: Array<Record<string, unknown>> } {
  const messages: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    messages,
    /** 方法 `send`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    send(raw: string) {
      messages.push(JSON.parse(raw) as Record<string, unknown>);
    },
  } as unknown as WebSocket & { messages: Array<Record<string, unknown>> };
}

/**
 * 函数 `waitFor` 的职责说明。
 * `waitFor` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 函数 `withTempWorkspace` 的职责说明。
 * `withTempWorkspace` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function withTempWorkspace(run: () => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-rebuild-ws-router-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  const previousCwd = process.cwd();
  const previousWorkspaceRoot = process.env.WORKSPACE_ROOT;
  try {
    closeDb();
    process.chdir(tempDir);
    process.env.WORKSPACE_ROOT = workspaceRoot;
    await run();
  } finally {
    closeDb();
    process.chdir(previousCwd);
    if (previousWorkspaceRoot === undefined) {
      delete process.env.WORKSPACE_ROOT;
    } else {
      process.env.WORKSPACE_ROOT = previousWorkspaceRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}
