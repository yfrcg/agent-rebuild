import type { GatewayRuntimeConfig } from "./config";

export function printRuntimeConfig(config: GatewayRuntimeConfig): void {
  console.log("[gateway config]");
  console.log(`- model: ${config.model}`);
  console.log(`- memoryTopK: ${config.memoryTopK}`);
  console.log(`- auditLogPath: ${config.auditLogPath}`);
  console.log(`- debug: ${config.debug}`);
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
