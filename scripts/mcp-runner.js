/**
 * ?????CS336 ???
 * ???scripts/mcp-runner.js
 * ????????
 * ????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

/**
 * 教学注释（CS336 风格）
 * 文件：scripts/mcp-runner.js
 * 功能：MCP 子进程托管脚本。
 * 学习目标：理解 Gateway 如何把受限制的 MCP 启动参数封装成一个可审计、可隐藏窗口的本地子进程。
 * 阅读提示：先看 base64 payload 的解析，再看 spawn 的 cwd/env/stdin/stdout 传递方式。
 */

const { spawn } = require("node:child_process");

/**
 * 函数 `main` 的职责说明。
 * `main` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function main() {
  const payloadBase64 = process.argv[2];
  if (!payloadBase64) {
    console.error("[mcp-runner] missing payload");
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf8"));
  } catch (error) {
    console.error(
      `[mcp-runner] invalid payload: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  if (!payload || typeof payload !== "object" || typeof payload.command !== "string") {
    console.error("[mcp-runner] payload.command must be a string");
    process.exit(1);
  }

  const child = spawn(payload.command, Array.isArray(payload.args) ? payload.args : [], {
    cwd: typeof payload.cwd === "string" ? payload.cwd : process.cwd(),
    env: isStringRecord(payload.env) ? payload.env : process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  child.on("error", (error) => {
    console.error(
      `[mcp-runner] child spawn failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  /** 函数变量 `forwardSignal`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
  const forwardSignal = (signal) => {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal);
      }
    });
  };

  forwardSignal("SIGINT");
  forwardSignal("SIGTERM");
}

/**
 * 函数 `isStringRecord` 的职责说明。
 * `isStringRecord` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function isStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => typeof item === "string");
}

main();
