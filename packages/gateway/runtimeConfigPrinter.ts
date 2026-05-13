/**
 * ?????CS336 ???
 * ???packages/gateway/runtimeConfigPrinter.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import type { GatewayRuntimeConfig } from "./config";

/**
 * 打印当前生效的 Gateway 运行时配置。
 *
 * 这一步主要用于启动时自检，帮助开发者快速确认：
 * 现在真正跑起来的模型、限流、熔断和 SLO 参数分别是什么。
 */
export function printRuntimeConfig(config: GatewayRuntimeConfig): void {
  console.log("[gateway config]");
  console.log(`- model: ${config.model}`);
  console.log(`- memoryTopK: ${config.memoryTopK}`);
  console.log(`- auditLogPath: ${config.auditLogPath}`);
  console.log(`- debug: ${config.debug}`);
  console.log(`- sandboxMode: ${config.sandboxMode}`);
  console.log(`- sandboxAllowedRoots: ${config.sandboxAllowedRoots.join(", ")}`);
  console.log(`- confirmTokenTtlMs: ${config.confirmTokenTtlMs}`);
  console.log(
    `- autoToolLoop: enabled=${config.autoToolLoopEnabled}, maxSteps=${config.autoToolLoopMaxSteps}`
  );
  console.log(
    `- sessionAutoCompact: enabled=${config.sessionAutoCompactEnabled}, maxEntries=${config.sessionAutoCompactMaxEntries}`
  );
  console.log(
    `- rateLimit: ${config.rateLimitMaxRequests} requests / ${config.rateLimitWindowMs}ms`
  );
  console.log(
    `- circuitBreaker: threshold=${config.circuitFailureThreshold}, cooldown=${config.circuitCooldownMs}ms`
  );
  console.log(
    `- slo: p95<=${config.sloMaxRtMs}ms, errorRate<=${config.sloMaxErrorRate}%`
  );
  console.log("");
}
