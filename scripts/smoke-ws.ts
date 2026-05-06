
import WebSocket from "ws";

import { createGatewayRuntime } from "../packages/gateway/runtime";
import { startGatewayWsServer } from "../packages/gateway/ws/wsServer";

process.env.GATEWAY_MODEL = process.env.GATEWAY_MODEL || "mock";
process.env.GATEWAY_WS_HOST = process.env.GATEWAY_WS_HOST || "127.0.0.1";
process.env.GATEWAY_WS_PORT = process.env.GATEWAY_WS_PORT || "8787";

/**
 * WS smoke 测试的单步超时时间。
 *
 * 可通过环境变量覆盖，方便 CI 或慢机器把连接和事件等待时间放宽。
 */
const SMOKE_TIMEOUT_MS = parsePositiveInteger(
  process.env.GATEWAY_WS_SMOKE_TIMEOUT_MS,
  30_000
);

/**
 * smoke 入口。
 *
 * 如果提供了 `GATEWAY_WS_URL`，就连接已有服务；否则本脚本会临时启动一个
 * mock 模型的 WS Gateway，跑完基础协议链路后再关闭。
 */
async function main(): Promise<void> {
  const explicitUrl = process.env.GATEWAY_WS_URL?.trim();
  const runtime = explicitUrl ? undefined : await createGatewayRuntime();
  const server = runtime ? await startGatewayWsServer(runtime) : undefined;
  try {
    await runSmoke(explicitUrl || server?.url || "ws://127.0.0.1:8787/v1/ws");
  } finally {
    await server?.close();
  }
}

/**
 * 执行一组端到端 WebSocket 基础能力检查。
 *
 * 覆盖连接握手、运行时状态、会话列表/创建、工具列表、记忆搜索和聊天运行事件，
 * 目标是快速确认服务能从请求响应走到异步事件广播。
 */
async function runSmoke(baseUrl: string): Promise<void> {
  const token = process.env.GATEWAY_WS_TOKEN;
  const url = appendToken(baseUrl, token);
  const ws = await connect(url);
  const events: Array<Record<string, unknown>> = [];
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (parsed.type === "event") events.push(parsed);
  });

  console.log("[ws-smoke] connect");
  await request(ws, "connect", { protocolVersion: "1.0", clientName: "smoke-ws" });
  console.log("[ws-smoke] connect pass");
  console.log("[ws-smoke] runtime.status");
  await request(ws, "runtime.status");
  console.log("[ws-smoke] runtime.status pass");
  console.log("[ws-smoke] session.list");
  const list = await request(ws, "session.list") as unknown[];
  console.log("[ws-smoke] session.list pass");
  let sessionId = readSessionId(list);
  if (!sessionId) {
    const created = await request(ws, "session.create", { name: "WS Smoke" }) as Record<string, unknown>;
    sessionId = String(created.id);
  }
  console.log("[ws-smoke] tool.list");
  await request(ws, "tool.list");
  console.log("[ws-smoke] tool.list pass");
  console.log("[ws-smoke] memory.search");
  await request(ws, "memory.search", { query: "WebSocket smoke" });
  console.log("[ws-smoke] memory.search pass");
  console.log("[ws-smoke] chat.send");
  await request(ws, "chat.send", {
    sessionId,
    input: "WS smoke: reply with one short sentence.",
  }, "ws-smoke-chat");
  console.log("[ws-smoke] chat.send pass");
  await waitForEvent(events, "run.started");
  await waitForEvent(events, "chat.completed");
  await waitForEvent(events, "run.finished");
  console.log("[ws-smoke] run.finished pass");
  ws.close();
  console.log("[ws-smoke] pass");
}

/** 在 URL 上追加 token 查询参数，供启用鉴权的本地服务使用。 */
function appendToken(baseUrl: string, token: string | undefined): string {
  if (!token) {
    return baseUrl;
  }
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
}

/** 建立 WS 连接，并用 Origin 头模拟浏览器客户端。 */
function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: "http://localhost:3000" } });
    const timer = setTimeout(
      () => reject(new Error(`WebSocket connect timeout after ${SMOKE_TIMEOUT_MS}ms`)),
      SMOKE_TIMEOUT_MS
    );
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

let nextRequestId = 1;
/**
 * 发送一个协议请求并等待同 id 的响应。
 *
 * 事件消息会被忽略，只消费 `type=res` 的同步响应；
 * 超时后会移除监听器，避免后续步骤收到旧监听器影响。
 */
function request(
  ws: WebSocket,
  method: string,
  params?: unknown,
  idempotencyKey?: string
): Promise<unknown> {
  const id = `smoke_${nextRequestId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for response to ${method}`));
    }, SMOKE_TIMEOUT_MS);
    /** 函数变量 `onMessage`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
    const onMessage = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (parsed.type !== "res" || parsed.id !== id) return;
      cleanup();
      parsed.ok
        ? resolve(parsed.payload)
        : reject(new Error(`${method} failed: ${JSON.stringify(parsed.error)}`));
    };
    /** 函数变量 `cleanup`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "req", id, method, params, idempotencyKey }));
  });
}

/** 从 session.list 返回值中读取第一个会话 id。 */
function readSessionId(list: unknown[]): string | undefined {
  const first = list[0];
  return first && typeof first === "object" && "id" in first
    ? String((first as { id: unknown }).id)
    : undefined;
}

/** 等待指定事件出现在事件缓存中。 */
async function waitForEvent(
  events: Array<Record<string, unknown>>,
  event: string
): Promise<void> {
  const startedAt = Date.now();
  while (!events.some((item) => item.event === event)) {
    if (Date.now() - startedAt > SMOKE_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for event ${event} after ${SMOKE_TIMEOUT_MS}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 解析正整数环境变量，非法值回落到默认值。 */
function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
