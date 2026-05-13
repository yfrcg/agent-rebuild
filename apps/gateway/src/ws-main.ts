/**
 * ?????CS336 ???
 * ???apps/gateway/src/ws-main.ts
 * ???Gateway ?????
 * ??????? CLI/WS ?????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { createGatewayRuntime } from "../../../packages/gateway/runtime";
import { startGatewayWsServer } from "../../../packages/gateway/ws/wsServer";

process.on("unhandledRejection", (reason) => {
  console.error("[ws-main] unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[ws-main] uncaughtException:", err);
  process.exit(1);
});

/**
 * WebSocket Gateway 命令行入口。
 *
 * 入口只负责创建运行时、启动 WS 服务和绑定进程信号；
 * 运行时装配和 WS 业务逻辑分别放在 `runtime.ts` 与 `wsServer.ts` 中。
 */
async function main(): Promise<void> {
  const runtime = await createGatewayRuntime();
  const handle = await startGatewayWsServer(runtime);
  console.log(`[ws-main] WebSocket server started: ${handle.url}`);

  let closing = false;
  /**
   * 统一处理 SIGINT/SIGTERM。
   *
   * `closing` 用来防止连续信号触发重复关闭，真正的优雅关闭流程由 server handle 完成。
   */
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    console.log("\n[ws-main] Shutting down...");
    try {
      await handle.close();
      console.log("[ws-main] Server closed.");
    } catch (err) {
      console.error("[ws-main] Error during shutdown:", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
