import * as readline from "node:readline";

import { FileAuditLogger } from "../../../packages/audit/auditLogger";

import { printBootstrapStatus } from "../../../packages/gateway/bootstrapPrinter";
import { GatewayCircuitBreaker } from "../../../packages/gateway/circuitBreaker";
import { loadGatewayConfig } from "../../../packages/gateway/config";
import { parseGatewayCommand } from "../../../packages/gateway/commandParser";
import { loadEnvFile } from "../../../packages/gateway/env";
import { Gateway } from "../../../packages/gateway/gateway";
import { createGatewayMemorySearch } from "../../../packages/gateway/memoryAdapter";
import { GatewayMetricsCollector } from "../../../packages/gateway/metricsCollector";
import { createModelProvider } from "../../../packages/gateway/modelProviderFactory";
import { printGatewayResponse } from "../../../packages/gateway/outputPrinter";
import { GatewayRateLimiter } from "../../../packages/gateway/rateLimiter";
import { createGatewayRequest } from "../../../packages/gateway/requestHandler";
import { printGatewayHelp } from "../../../packages/gateway/replHelp";
import { askReplInput } from "../../../packages/gateway/replInput";
import { handleBuiltInGatewayCommand } from "../../../packages/gateway/replCommandHandlers";
import { printRuntimeConfig } from "../../../packages/gateway/runtimeConfigPrinter";
import {
  createGatewaySessionId,
  recordTranscript,
} from "../../../packages/gateway/transcriptRecorder";

async function main(): Promise<void> {
  loadEnvFile();

  const sessionId = createGatewaySessionId();
  const config = loadGatewayConfig();
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

  const gateway = new Gateway({
    memorySearch: createGatewayMemorySearch(config.memoryTopK),
    modelProvider,
    auditLogger: new FileAuditLogger(config.auditLogPath),
    debug: config.debug,
    rateLimiter,
    circuitBreaker,
    metricsCollector,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    const raw = (await askReplInput(rl, ">>> ")).trim();
    if (!raw) continue;

    const command = parseGatewayCommand(raw);

    recordTranscript(sessionId, "user", command.raw);

    const commandResult = await handleBuiltInGatewayCommand(command, {
      sessionId,
      memoryTopK: config.memoryTopK,
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

    recordTranscript(sessionId, "assistant", response.text);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
