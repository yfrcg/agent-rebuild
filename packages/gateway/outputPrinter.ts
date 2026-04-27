import type { GatewayResponse } from "./types";

export function printGatewayResponse(response: GatewayResponse): void {
  printResponseText(response);
  printMemoryUsed(response);
  printDebugInfo(response);
  printError(response);
}

function printResponseText(response: GatewayResponse): void {
  console.log("\n[gateway response]");
  console.log(response.text);
}

function printMemoryUsed(response: GatewayResponse): void {
  if (response.memoryUsed.length === 0) {
    console.log("\n[memory used] no memory hits");
    return;
  }

  console.log("\n[memory used]");

  response.memoryUsed.forEach((item, index) => {
    console.log(`#${index + 1} ${item.source ?? "unknown"}`);
    console.log(item.content.slice(0, 160));
  });
}

function printDebugInfo(response: GatewayResponse): void {
  if (!response.debug) {
    return;
  }

  console.log("\n[gateway debug]");
  console.log(`modelProvider: ${response.debug.modelProvider}`);
  console.log(`memoryCount: ${response.debug.memoryCount}`);
  console.log(`durationMs: ${response.debug.durationMs}`);
  console.log(`hasError: ${response.debug.hasError}`);
  if (response.debug.rateLimit) {
    console.log(
      `rateLimit: remaining=${response.debug.rateLimit.remaining}/${response.debug.rateLimit.limit}, retryAfterMs=${response.debug.rateLimit.retryAfterMs}`
    );
  }
  if (response.debug.metrics) {
    console.log(
      `metrics: total=${response.debug.metrics.totalRequests}, errorRate=${response.debug.metrics.errorRate}%, p95=${response.debug.metrics.p95DurationMs}ms, circuit=${response.debug.metrics.circuitState}`
    );
  }
}

function printError(response: GatewayResponse): void {
  if (!response.error) {
    return;
  }

  console.log("\n[gateway error]");
  console.log(response.error);
}
