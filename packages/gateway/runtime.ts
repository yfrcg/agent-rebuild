/**
 * ?????CS336 ???
 * ???packages/gateway/runtime.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { FileAuditLogger } from "../audit/auditLogger";
import { resolveProjectRoot } from "../core/src/config";
import { createBuiltinToolRegistry } from "./builtinTools";
import { GatewayCircuitBreaker } from "./circuitBreaker";
import { loadGatewayConfig } from "./config";
import type { GatewayRuntimeConfig } from "./config";
import { loadEnvFile } from "./env";
import { Gateway } from "./gateway";
import type { MemorySearch } from "./gateway";
import { createGatewayMemorySearch } from "./memoryAdapter";
import { loadGatewayMcpServerConfigs } from "./mcpConfig";
import { GatewayMcpManager } from "./mcpManager";
import type { GatewayMcpServerConfig } from "./mcpTypes";
import { GatewayMetricsCollector } from "./metricsCollector";
import { createSwitchableModelProvider } from "./modelProviderFactory";
import type { ModelProvider } from "../model/types";
import { GatewayRateLimiter } from "./rateLimiter";
import { GatewaySandbox } from "./sandbox";
import { SessionManager } from "./sessionManager";
import { SessionStore } from "./sessionStore";
import { ToolCallExecutor } from "./toolCallExecutor";
import { ToolRegistry } from "./toolRegistry";
import { MemoryScheduler } from "./memoryScheduler";

/**
 * Gateway 启动后组装好的运行时对象。
 *
 * CLI、HTTP/WS 入口和测试都可以复用这个对象，避免每个入口重复创建模型、
 * 会话、沙箱、MCP、工具注册表和审计日志等基础设施。
 */
export interface GatewayRuntime {
  projectRoot: string;
  config: GatewayRuntimeConfig;
  gateway: Gateway;
  modelProvider: ModelProvider;
  sessionManager: SessionManager;
  sandbox: GatewaySandbox;
  auditLogger: FileAuditLogger;
  memorySearch: MemorySearch;
  toolRegistry: ToolRegistry;
  toolCallExecutor: ToolCallExecutor;
  mcpManager: GatewayMcpManager;
  metricsCollector: GatewayMetricsCollector;
  memoryScheduler: MemoryScheduler;
  setModelProvider(model: GatewayRuntimeConfig["model"]): void;
  /** 方法 `close`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
  close(): Promise<void>;
}

/**
 * 按 CS336 的“先定义接口，再实现计算图”思路创建完整 Gateway 运行时。
 *
 * Args:
 *   无。运行时依赖从 `.env`、项目根目录和本地配置文件中读取。
 *
 * Returns:
 *   Promise<GatewayRuntime>：已经装配好的 Gateway、模型、会话、工具、MCP、审计、指标和记忆服务。
 *
 * 学习提示：
 *   这里是 Composition Root。初学者可以把它当成“模型前向传播前的网络搭建”：
 *   先创建依赖，再把依赖注入到 Gateway，最后暴露统一的运行时对象给 CLI 和 WebSocket。
 */
export async function createGatewayRuntime(): Promise<GatewayRuntime> {
  // Learning note: this is the composition root. Start here to see how config,
  // model providers, memory, tools, sessions, MCP, metrics, and Gateway are wired.
  loadEnvFile();

  const projectRoot = resolveProjectRoot(process.env);
  const config = loadGatewayConfig();
  const sessionStore = new SessionStore({
    defaultAllowedReadRoots: config.sandboxAllowedRoots,
    defaultAllowedWriteRoots: config.sandboxAllowedRoots,
    defaultPermission: "project-write",
  });
  const sessionManager = new SessionManager(sessionStore);
  const sandbox = new GatewaySandbox({
    mode: config.sandboxMode,
    allowedRoots: config.sandboxAllowedRoots,
  });

  let mcpConfigs: GatewayMcpServerConfig[] = [];
  try {
    mcpConfigs = loadGatewayMcpServerConfigs();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] config load failed, continue without MCP servers. ${message}`);
  }

  const mcpLazy = Boolean((config as unknown as Record<string, unknown>).mcpLazy);
  const mcpManager = new GatewayMcpManager(mcpConfigs, sandbox, { lazy: mcpLazy });
  const modelProvider = createSwitchableModelProvider(config.model);
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
  const auditLogger = new FileAuditLogger(config.auditLogPath);
  const memorySearch = createGatewayMemorySearch(config.memoryTopK);
  const toolRegistry = createBuiltinToolRegistry({
    memorySearch,
    memoryTopK: config.memoryTopK,
    projectRoot,
    tavilyApiKey: config.tavilyApiKey || undefined,
  });

  if (mcpLazy) {
    console.log("[mcp] lazy mode: servers will connect on first handle() call");
  } else {
    // 非懒加载模式在启动阶段完成 MCP 连接和工具注册，启动失败能更早暴露。
    await mcpManager.connectEnabledServers();
    await mcpManager.registerTools(toolRegistry);
  }

  const toolCallExecutor = new ToolCallExecutor({
    registry: toolRegistry,
    auditLogger,
    sandbox,
  });

  const memoryScheduler = new MemoryScheduler();

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
    autoReviewGraphEnabled: config.autoReviewGraphEnabled,
    devTaskMaxSteps: config.devTaskMaxSteps,
    devTaskMaxFixRounds: config.devTaskMaxFixRounds,
    sessionTokenBudget: config.sessionTokenBudget,
    sessionCostBudgetCents: config.sessionCostBudgetCents,
    sessionManager,
    mcpManager: mcpLazy ? mcpManager : undefined,
    reviewGraphOptions: config.reviewGraphMaxToolCallsPerAgent > 0
      ? { maxToolCallsPerAgent: config.reviewGraphMaxToolCallsPerAgent }
      : undefined,
  });

  // Start background memory scheduler
  memoryScheduler.start();

  return {
    projectRoot,
    config,
    gateway,
    modelProvider,
    sessionManager,
    sandbox,
    auditLogger,
    memorySearch,
    toolRegistry,
    toolCallExecutor,
    mcpManager,
    metricsCollector,
    memoryScheduler,
    setModelProvider(model: GatewayRuntimeConfig["model"]): void {
      modelProvider.setModel(model);
      config.model = model;
    },
    /** 统一关闭运行时持有的外部连接，当前主要是 MCP 子进程/连接。 */
    async close(): Promise<void> {
      memoryScheduler.stop();
      await mcpManager.close();
    },
  };
}
