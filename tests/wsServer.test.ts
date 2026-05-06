
import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";

import type { GatewayRuntime } from "../packages/gateway/runtime";
import { startGatewayWsServer } from "../packages/gateway/ws/wsServer";

test("ws server returns BAD_REQUEST for invalid JSON", async () => {
  await withWsEnv({
    GATEWAY_WS_PORT: String(nextPort()),
    GATEWAY_WS_TOKEN: "",
  }, async () => {
    const server = await startGatewayWsServer(runtimeDouble());
    try {
      const ws = await connect(server.url);
      ws.send("{not-json");
      const message = await nextMessage(ws);
      const parsed = JSON.parse(message) as {
        ok: boolean;
        error?: { code?: string };
      };

      assert.equal(parsed.ok, false);
      assert.equal(parsed.error?.code, "BAD_REQUEST");
      ws.close();
    } finally {
      await server.close();
    }
  });
});

test("ws server rejects auth failures without crashing", async () => {
  await withWsEnv({
    GATEWAY_WS_PORT: String(nextPort()),
    GATEWAY_WS_TOKEN: "test-token",
  }, async () => {
    const server = await startGatewayWsServer(runtimeDouble());
    try {
      const error = await connectError(server.url);

      assert.match(error.message, /401|Unexpected server response/);
    } finally {
      await server.close();
    }
  });
});

/**
 * 函数 `connect` 的职责说明。
 * `connect` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: "http://localhost:3000" } });
    const timer = setTimeout(() => reject(new Error("connect timeout")), 1_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 函数 `connectError` 的职责说明。
 * `connectError` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function connectError(url: string): Promise<Error> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: "http://localhost:3000" } });
    const timer = setTimeout(() => reject(new Error("auth failure timeout")), 1_000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("expected auth failure"));
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      resolve(err);
    });
  });
}

/**
 * 函数 `nextMessage` 的职责说明。
 * `nextMessage` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 1_000);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(raw.toString());
    });
  });
}

/**
 * 函数 `withWsEnv` 的职责说明。
 * `withWsEnv` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function withWsEnv(
  values: Record<string, string>,
  run: () => Promise<void>
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  previous.set("GATEWAY_WS_HOST", process.env.GATEWAY_WS_HOST);
  process.env.GATEWAY_WS_HOST = "127.0.0.1";
  try {
    await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * 函数 `runtimeDouble` 的职责说明。
 * `runtimeDouble` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function runtimeDouble(): GatewayRuntime {
  return {
    auditLogger: { async log() {} },
    /** 方法 `close`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async close() {},
  } as unknown as GatewayRuntime;
}

/**
 * 函数 `nextPort` 的职责说明。
 * `nextPort` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function nextPort(): number {
  return 18_000 + Math.floor(Math.random() * 1_000);
}
