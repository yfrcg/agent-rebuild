import * as readline from "node:readline";

import { FileAuditLogger } from "../../../packages/audit/auditLogger";

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
import { SessionManager } from "../../../packages/gateway/sessionManager";
import { ToolCallExecutor } from "../../../packages/gateway/toolCallExecutor";
import { recordTranscript } from "../../../packages/gateway/transcriptRecorder";

async function main(): Promise<void> {
  loadEnvFile();

  const sessionManager = new SessionManager();
  const config = loadGatewayConfig();
  let mcpConfigs: GatewayMcpServerConfig[] = [];
  try {
    mcpConfigs = loadGatewayMcpServerConfigs();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] config load failed, continue without MCP servers. ${message}`);
  }
  const mcpManager = new GatewayMcpManager(mcpConfigs);
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

  printBootstrapStatus();
  printRuntimeConfig(config);
  printGatewayHelp();

  console.log(`[gateway] model provider: ${modelProvider.name}`);
  const auditLogger = new FileAuditLogger(config.auditLogPath);
  const memorySearch = createGatewayMemorySearch(config.memoryTopK);
  const toolRegistry = createBuiltinToolRegistry({
    memorySearch,
    memoryTopK: config.memoryTopK,
  });
  await mcpManager.connectEnabledServers();
  await mcpManager.registerTools(toolRegistry);
  const toolCallExecutor = new ToolCallExecutor({
    registry: toolRegistry,
    auditLogger,
  });

  const gateway = new Gateway({
    memorySearch,
    modelProvider,
    auditLogger,
    debug: config.debug,
    rateLimiter,
    circuitBreaker,
    metricsCollector,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const raw = (await askReplInput(rl, ">>> ")).trim();
      if (!raw) continue;

      const command = parseGatewayCommand(raw);
      const sessionId = sessionManager.getCurrentSessionId();

      recordTranscript(sessionId, "user", command.raw);
      sessionManager.incrementCurrentSessionMessageCount();

      const commandResult = await handleBuiltInGatewayCommand(command, {
        sessionManager,
        toolRegistry,
        toolCallExecutor,
        memoryTopK: config.memoryTopK,
        mcpManager,
        rl,
      });

      if (commandResult.shouldExit) {
        break;
      }

      if (commandResult.handled) {
        continue;
      }

      const request = createGatewayRequest(command.payload ?? command.raw);
      const response = await gateway.handle(request);

      printGatewayResponse(response);

      const activeSessionId = sessionManager.getCurrentSessionId();
      recordTranscript(activeSessionId, "assistant", response.text);
      sessionManager.incrementCurrentSessionMessageCount();
    }
  } finally {
    rl.close();
    await mcpManager.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
