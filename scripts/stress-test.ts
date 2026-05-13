/**
 * Stress Test Script for Agent-Rebuild
 *
 * Connects to the gateway via WebSocket, creates a session bound to WORKLOAD_DIR,
 * sends a stress test task, and monitors the agent's execution.
 *
 * Usage: npx tsx scripts/stress-test.ts
 */

import WebSocket from "ws";

const GATEWAY_URL = "ws://127.0.0.1:8787/v1/ws";
const WORKLOAD_DIR = "D:\\WorkStation\\CoLab";
const CLIENT_NAME = "stress-test";

const STRESS_TASK = `你现在进入"中型项目从零实现压力测试"。

你的工作目录是：

${WORKLOAD_DIR}

你必须在这个目录中从零实现一个 TypeScript + Node.js 中型项目。

项目名：

LocalForge Runtime Lab

项目规模：

- 目标总代码量：6000 到 9000 行。
- 约等于 7000 行左右。
- 不允许用大量无意义注释、空文件、重复垃圾代码凑行数。
- 必须是真实可运行、可构建、可测试的项目。

项目主题：

实现一个本地优先 Agent Runtime 实验框架，用于模拟：

- 工具注册；
- 权限控制；
- 会话管理；
- 记忆检索；
- 审计日志；
- todo/task 管理；
- Agent Runner 循环；
- CLI 调用；
- 错误处理；
- 自动修复记录。

必须实现模块：

1. CLI
   - init
   - run
   - tools list
   - tools call
   - memory write
   - memory search
   - session new
   - session list
   - audit list
   - todo add
   - todo list

2. Tool Registry
   - registerTool
   - getTool
   - listTools
   - callTool
   - 工具元数据：
     - name
     - description
     - inputSchema
     - readOnly
     - permissionLevel
     - timeoutMs
     - handler

3. 内置工具至少 10 个
   - file.read
   - file.write
   - file.list
   - file.search
   - shell.run
   - memory.write
   - memory.search
   - session.info
   - todo.write
   - todo.list
   - audit.query

4. Permission System
   - allow / ask / deny
   - 拦截危险命令：
     - rm -rf
     - del /s
     - rmdir /s
     - git push
     - npm publish
   - 禁止读取 .env、token、secret 文件。
   - file.write 只能写入项目目录内部。

5. Session System
   - 创建 session
   - 切换 session
   - 保存 transcript
   - 保存 currentGoal
   - 保存 workingDir
   - JSON 持久化

6. Memory System
   - memory.write
   - memory.search
   - 简单关键词评分或 BM25
   - 支持 tag 过滤
   - 支持 sessionId 过滤
   - JSON 持久化

7. Audit System
   - 每次工具调用记录：
     - toolName
     - argsPreview
     - startedAt
     - durationMs
     - status
     - error
     - workingDir

8. Todo System
   - pending
   - running
   - done
   - failed
   - 支持创建、更新、查询

9. Agent Runner
   - 输入任务
   - 检索 memory
   - 选择工具
   - 执行工具
   - 写 audit
   - 更新 transcript
   - 支持 maxSteps
   - 工具失败后不能直接崩溃，要结构化返回错误

10. 测试
   - 至少 60 个真实测试用例。
   - 覆盖：
     - 工具注册
     - 工具调用
     - 权限拦截
     - 文件路径限制
     - shell.run 危险命令拒绝
     - memory 写入/搜索
     - session 创建/列表
     - audit 记录
     - todo 状态更新
     - Agent Runner maxSteps
     - CLI 基本命令
     - 错误处理

工程要求：

1. 必须生成 package.json。
2. 必须生成 tsconfig.json。
3. 必须生成 README.md。
4. 必须有 src 目录。
5. 必须有 tests 目录。
6. 必须支持：
   npm install
   npm run build
   npm test
7. TypeScript 必须 strict。
8. 不能留下明显空实现。
9. 不能跳过测试。
10. 最后必须输出真实验收结果。

你必须自己循环执行：

npm install
npm run build
npm test

如果失败，读取错误、修改代码、重跑命令，直到全部通过。`;

let requestId = 0;
let sessionId = "";
const events: Array<{ event: string; timestamp: string; data: unknown }> = [];

function log(msg: string, data?: unknown) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
  if (data) {
    events.push({ event: msg, timestamp: ts, data });
  }
}

function sendRequest(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `stress_${++requestId}`;
    const timeout = setTimeout(() => reject(new Error(`Request ${id} timed out`)), 120_000);

    const handler = (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "res" && msg.id === id) {
          clearTimeout(timeout);
          ws.off("message", handler);
          if (msg.ok) {
            resolve(msg.payload);
          } else {
            reject(new Error(msg.error?.message ?? "Unknown error"));
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify({ id, type: "req", method, params }));
  });
}

function setupEventMonitor(ws: WebSocket) {
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "event") {
        const event = msg as { event: string; payload?: unknown; runId?: string };
        const ts = new Date().toISOString();

        switch (event.event) {
          case "chat.delta": {
            const payload = event.payload as { delta?: string } | undefined;
            if (payload?.delta) {
              process.stdout.write(payload.delta);
            }
            break;
          }
          case "chat.completed": {
            const payload = event.payload as { text?: string; toolCalls?: unknown[]; error?: string } | undefined;
            log(`\n[COMPLETED] text=${(payload?.text ?? "").slice(0, 200)}...`);
            log(`[COMPLETED] toolCalls=${Array.isArray(payload?.toolCalls) ? payload.toolCalls.length : 0}`);
            if (payload?.error) log(`[ERROR] ${payload.error}`);
            break;
          }
          case "tool.started": {
            const payload = event.payload as { toolName?: string; inputPreview?: unknown } | undefined;
            log(`[TOOL_STARTED] ${payload?.toolName ?? "unknown"}`);
            break;
          }
          case "tool.finished": {
            const payload = event.payload as { toolName?: string; durationMs?: number; result?: { ok?: boolean } } | undefined;
            log(`[TOOL_FINISHED] ${payload?.toolName ?? "unknown"} ok=${payload?.result?.ok} duration=${payload?.durationMs}ms`);
            break;
          }
          case "tool.failed": {
            const payload = event.payload as { toolName?: string; error?: string } | undefined;
            log(`[TOOL_FAILED] ${payload?.toolName ?? "unknown"} error=${payload?.error ?? "unknown"}`);
            break;
          }
          case "tool.denied": {
            const payload = event.payload as { toolName?: string; error?: string } | undefined;
            log(`[TOOL_DENIED] ${payload?.toolName ?? "unknown"} reason=${payload?.error ?? "unknown"}`);
            break;
          }
          case "run.finished": {
            log("[RUN_FINISHED]");
            break;
          }
          case "run.failed": {
            const payload = event.payload as { error?: string } | undefined;
            log(`[RUN_FAILED] ${payload?.error ?? "unknown"}`);
            break;
          }
          default:
            // Other events - just log briefly
            break;
        }
      }
    } catch {
      // ignore
    }
  });
}

async function main() {
  log("Connecting to gateway...");
  const ws = new WebSocket(GATEWAY_URL, {
    headers: {
      Origin: "http://localhost:3000",
    },
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", (err) => reject(err));
  });

  log("Connected. Setting up event monitor...");
  setupEventMonitor(ws);

  // Step 1: Connect
  log("Sending connect request...");
  const connectResult = await sendRequest(ws, "connect", {
    clientName: CLIENT_NAME,
    clientVersion: "1.0.0",
    protocolVersion: "1.0",
  }) as Record<string, unknown>;
  log("Connected.", { capabilities: connectResult.capabilities });

  // Step 2: Create session bound to WORKLOAD_DIR
  log("Creating session...");
  const sessionResult = await sendRequest(ws, "session.create", {
    name: "stress-test-session",
  }) as { id?: string; sessionId?: string };
  sessionId = sessionResult.id ?? sessionResult.sessionId ?? "";
  log(`Session created: ${sessionId}`);

  // Step 3: Bind project
  log(`Binding session to ${WORKLOAD_DIR}...`);
  await sendRequest(ws, "session.bindProject", {
    sessionId,
    projectDir: WORKLOAD_DIR,
  });
  log("Session bound to project.");

  // Step 4: Send stress task
  log("Sending stress task...");
  log("Task length: " + STRESS_TASK.length + " chars");

  const chatResult = await sendRequest(ws, "chat.send", {
    sessionId,
    input: STRESS_TASK,
  }) as { runId?: string };
  log(`Chat sent. runId=${chatResult.runId}`);

  // Step 5: Wait for completion
  // The events will stream in via the event monitor
  // We wait until we see a chat.completed or run.finished event
  log("Waiting for agent to complete...");
  log("(Monitoring events - press Ctrl+C to abort)");

  // Keep the process alive and monitoring events
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      // Check if we've received a completion event
      const lastEvent = events[events.length - 1];
      if (lastEvent?.event === "[COMPLETED]" || lastEvent?.event === "[RUN_FINISHED]" || lastEvent?.event === "[RUN_FAILED]") {
        clearInterval(checkInterval);
        resolve();
      }
    }, 1000);

    // Safety timeout: 30 minutes
    setTimeout(() => {
      clearInterval(checkInterval);
      log("[TIMEOUT] 30 minute timeout reached");
      resolve();
    }, 30 * 60 * 1000);
  });

  // Step 6: Report
  log("\n=== STRESS TEST SUMMARY ===");
  log(`Session: ${sessionId}`);
  log(`Events captured: ${events.length}`);

  // Save events to file
  const fs = await import("node:fs");
  const reportPath = "logs/stress-test-report.json";
  fs.mkdirSync("logs", { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    sessionId,
    startTime: events[0]?.timestamp,
    endTime: events[events.length - 1]?.timestamp,
    eventCount: events.length,
    events: events.filter(e =>
      e.event.startsWith("[TOOL_") ||
      e.event.startsWith("[COMPLETED]") ||
      e.event.startsWith("[RUN_") ||
      e.event.startsWith("[ERROR")
    ),
  }, null, 2));
  log(`Report saved to ${reportPath}`);

  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Stress test failed:", err);
  process.exit(1);
});
