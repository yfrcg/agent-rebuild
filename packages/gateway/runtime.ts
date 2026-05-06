
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
import { createModelProvider } from "./modelProviderFactory";
import type { ModelProvider } from "../model/types";
import { GatewayRateLimiter } from "./rateLimiter";
import { GatewaySandbox } from "./sandbox";
import { SessionManager } from "./sessionManager";
import { SessionStore } from "./sessionStore";
import { ToolCallExecutor } from "./toolCallExecutor";
import { ToolRegistry } from "./toolRegistry";

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
  /** 方法 `close`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
  close(): Promise<void>;
}

/**
 * 创建完整 Gateway 运行时。
 *
 * 这里集中完成环境变量加载、项目根解析、配置读取、会话存储、沙箱、
 * MCP 管理器、模型供应商、限流器、熔断器、指标、审计、记忆检索和工具执行器的装配。
 * 如果 MCP 配置加载失败，会降级为无 MCP 服务继续启动，保证本地基础能力可用。
 */
export async function createGatewayRuntime(): Promise<GatewayRuntime> {
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
    devTaskMaxSteps: config.devTaskMaxSteps,
    devTaskMaxFixRounds: config.devTaskMaxFixRounds,
    sessionManager,
    mcpManager: mcpLazy ? mcpManager : undefined,
  });

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
    /** 统一关闭运行时持有的外部连接，当前主要是 MCP 子进程/连接。 */
    async close(): Promise<void> {
      await mcpManager.close();
    },
  };
}
