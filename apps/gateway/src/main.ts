import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

import { FileAuditLogger } from "../../../packages/audit/auditLogger";
import { resolveProjectRoot } from "../../../packages/core/src/config";

import { printBootstrapStatus } from "../../../packages/gateway/bootstrapPrinter";
import { createBuiltinToolRegistry } from "../../../packages/gateway/builtinTools";
import { GatewayCircuitBreaker } from "../../../packages/gateway/circuitBreaker";
import { loadGatewayConfig } from "../../../packages/gateway/config";
import { parseGatewayCommand } from "../../../packages/gateway/commandParser";
import { loadEnvFile } from "../../../packages/gateway/env";
import { Gateway } from "../../../packages/gateway/gateway";
import { createGatewayMemorySearch } from "../../../packages/gateway/memoryAdapter";
import { loadGatewayMcpServerConfigs } from "../../../packages/gateway/mcpConfig";
import { GatewayMcpManager } from "../../../packages/gateway/mcpManager";
import type { GatewayMcpServerConfig } from "../../../packages/gateway/mcpTypes";
import { GatewayMetricsCollector } from "../../../packages/gateway/metricsCollector";
import { createModelProvider } from "../../../packages/gateway/modelProviderFactory";
import { printGatewayResponse } from "../../../packages/gateway/outputPrinter";
import { GatewayRateLimiter } from "../../../packages/gateway/rateLimiter";
import { createGatewayRequest } from "../../../packages/gateway/requestHandler";
import { printGatewayHelp } from "../../../packages/gateway/replHelp";
import { askReplInput } from "../../../packages/gateway/replInput";
import { handleBuiltInGatewayCommand } from "../../../packages/gateway/replCommandHandlers";
import { printRuntimeConfig } from "../../../packages/gateway/runtimeConfigPrinter";
import { GatewaySandbox } from "../../../packages/gateway/sandbox";
import { maybeAutoCompactSession } from "../../../packages/gateway/sessionAutoCompaction";
import { SessionManager } from "../../../packages/gateway/sessionManager";
import { ToolCallExecutor } from "../../../packages/gateway/toolCallExecutor";
import { recordTranscript } from "../../../packages/gateway/transcriptRecorder";

/**
 * 启动 Gateway 的命令行主循环。
 *
 * 这个函数负责把整个应用的依赖关系串起来：
 * 1. 先加载 `.env` 和运行时配置。
 * 2. 初始化模型、记忆检索、MCP 管理器、审计、限流、熔断、指标等基础组件。
 * 3. 进入 REPL 循环，持续读取用户输入。
 * 4. 先尝试执行内建命令，未命中时再走正常的 Gateway 对话链路。
 * 5. 将用户消息和模型回复都写入 transcript，保证后续可以做会话恢复与压缩。
 */
async function main(): Promise<void> {
  // 优先加载本地环境变量，让后续配置读取拥有完整上下文。
  loadEnvFile();

  const projectRoot = resolveProjectRoot(process.env);
  const sessionManager = new SessionManager();
  const config = loadGatewayConfig();
  const sandbox = new GatewaySandbox({
    mode: config.sandboxMode,
    allowedRoots: config.sandboxAllowedRoots,
  });
  let mcpConfigs: GatewayMcpServerConfig[] = [];

  // MCP 配置属于增强能力，读取失败时只降级，不阻断主程序启动。
  try {
    mcpConfigs = loadGatewayMcpServerConfigs();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] config load failed, continue without MCP servers. ${message}`);
  }

  const mcpManager = new GatewayMcpManager(mcpConfigs, sandbox);
  const modelProvider = createModelProvider(config.model);
  const rateLimiter = new GatewayRateLimiter({
    maxRequests: config.rateLimitMaxRequests,
    windowMs: config.rateLimitWindowMs,
  });
  const circuitBreaker = new GatewayCircuitBreaker({
    failureThreshold: config.circuitFailureThreshold,
    cooldownMs: config.circuitCooldownMs,
  });
  const metricsCollector = new GatewayMetricsCollector({
    maxRtMs: config.sloMaxRtMs,
    maxErrorRate: config.sloMaxErrorRate,
  });

  // 启动时先把系统上下文、配置和帮助信息打印出来，便于操作者确认环境状态。
  printBootstrapStatus();
  printRuntimeConfig(config);
  printGatewayHelp();

  console.log(`[gateway] model provider: ${modelProvider.name}`);

  const auditLogger = new FileAuditLogger(config.auditLogPath);
  const memorySearch = createGatewayMemorySearch(config.memoryTopK);
  const toolRegistry = createBuiltinToolRegistry({
    memorySearch,
    memoryTopK: config.memoryTopK,
    projectRoot,
  });

  // 先连接 MCP 服务，再把其工具映射进统一工具注册表。
  await mcpManager.connectEnabledServers();
  await mcpManager.registerTools(toolRegistry);

  const toolCallExecutor = new ToolCallExecutor({
    registry: toolRegistry,
    auditLogger,
    sandbox,
  });

  const gateway = new Gateway({
    memorySearch,
    modelProvider,
    toolRegistry,
    toolCallExecutor,
    auditLogger,
    debug: config.debug,
    rateLimiter,
    circuitBreaker,
    metricsCollector,
    sandbox,
    autoToolLoopEnabled: config.autoToolLoopEnabled,
    autoToolLoopMaxSteps: config.autoToolLoopMaxSteps,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const maybeRunSessionCompaction = (): void => {
    const activeSessionId = sessionManager.getCurrentSessionId();
    const result = maybeAutoCompactSession(activeSessionId, {
      enabled: config.sessionAutoCompactEnabled,
      maxEntries: config.sessionAutoCompactMaxEntries,
    });

    if (!result) {
      return;
    }

    const notice = `[session] auto-compacted flushed=${result.flushed} target=${result.target} truncated=${result.truncated}`;
    console.log(notice);
    recordTranscript(activeSessionId, "tool", notice);
    sessionManager.incrementCurrentSessionMessageCount();
  };

  try {
    while (true) {
      let rawInput: string;
      try {
        rawInput = await askReplInput(rl, ">>> ");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes("readline closed") ||
          message.includes("readline was closed") ||
          message.includes("ERR_USE_AFTER_CLOSE")
        ) {
          break;
        }
        throw err;
      }

      // 读取一行输入并去掉首尾空白，空输入直接忽略。
      const raw = rawInput.trim();
      if (!raw) continue;

      const command = parseGatewayCommand(raw);
      const sessionId = sessionManager.getCurrentSessionId();

      // 无论是命令还是普通聊天，用户原始输入都先写入会话记录。
      recordTranscript(sessionId, "user", command.raw);
      sessionManager.incrementCurrentSessionMessageCount();

      const commandResult = await handleBuiltInGatewayCommand(command, {
        sessionManager,
        toolRegistry,
        toolCallExecutor,
        memoryTopK: config.memoryTopK,
        mcpManager,
        sandbox,
        auditLogger,
        confirmTokenTtlMs: config.confirmTokenTtlMs,
        rl,
      });

      if (commandResult.shouldExit) {
        break;
      }

      // 命令已处理完成时，不再进入模型对话链路。
      if (commandResult.handled) {
        maybeRunSessionCompaction();
        continue;
      }

      const request = createGatewayRequest(command.payload ?? command.raw, {
        sessionId: sessionManager.getCurrentSessionId(),
        activeSkills: sessionManager.getCurrentSession().activeSkills ?? [],
        permissionMode:
          sessionManager.getCurrentSession().permissionMode ?? "default",
        planState: sessionManager.getCurrentSession().planState,
      });
      const response = await gateway.handle(request);

      printGatewayResponse(response);

      const currentSession = sessionManager.getCurrentSession();
      if (currentSession.permissionMode === "plan" && currentSession.planState?.active) {
        const updatedPlan = {
          ...currentSession.planState,
          status: "awaiting_approval" as const,
          summary: response.text.split(/\r?\n/, 1)[0]?.slice(0, 200),
          content: response.text,
          updatedAt: new Date().toISOString(),
        };
        if (updatedPlan.planPath) {
          fs.mkdirSync(path.dirname(updatedPlan.planPath), {
            recursive: true,
          });
          fs.writeFileSync(
            updatedPlan.planPath,
            [
              `# Plan ${updatedPlan.planId ?? ""}`.trim(),
              "",
              `status: ${updatedPlan.status}`,
              `active: ${String(updatedPlan.active)}`,
              `updatedAt: ${updatedPlan.updatedAt}`,
              "",
              updatedPlan.content ?? "_No plan content yet._",
              "",
            ].join("\n"),
            "utf8"
          );
        }
        sessionManager.setCurrentSessionPlanState(updatedPlan);
      }


      // 回复记录写入当前活跃会话，而不是沿用旧变量，避免命令切换会话后写错文件。
      const activeSessionId = sessionManager.getCurrentSessionId();
      recordTranscript(activeSessionId, "assistant", response.text);
      sessionManager.incrementCurrentSessionMessageCount();
      maybeRunSessionCompaction();
    }
  } finally {
    // 退出时要主动释放终端与 MCP 连接，避免遗留后台资源。
    rl.close();
    await mcpManager.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
