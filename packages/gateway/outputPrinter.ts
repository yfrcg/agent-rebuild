
import type { GatewayResponse } from "./types";

/**
 * 统一打印一条 Gateway 响应。
 *
 * 输出被拆成正文、命中的记忆、调试信息和错误信息四个部分，
 * 这样终端展示更有层次，也便于后续单独调整格式。
 */
export function printGatewayResponse(response: GatewayResponse): void {
  printResponseText(response);
  printToolCalls(response);
  printMemoryUsed(response);
  printDebugInfo(response);
  printError(response);
}

/**
 * 打印模型最终返回的正文。
 */
function printResponseText(response: GatewayResponse): void {
  console.log("\n[gateway response]");
  console.log(response.text);
}

/**
 * 打印本次回答实际引用过的记忆摘要。
 *
 * 这里不会完整展开全部内容，而是只展示来源和前 160 个字符，
 * 目的是让操作者快速判断“模型是不是用了对的记忆”。
 */
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

/**
 * 打印自动工具调用摘要。
 */
function printToolCalls(response: GatewayResponse): void {
  if (!response.toolCalls || response.toolCalls.length === 0) {
    return;
  }

  console.log("\n[tool calls]");

  response.toolCalls.forEach((record, index) => {
    console.log(
      `#${index + 1} ${record.toolName} status=${record.status} durationMs=${record.durationMs ?? 0}`
    );

    if (record.error) {
      console.log(`error: ${record.error}`);
    }
  });
}

/**
 * 打印调试信息。
 *
 * 只有在 debug 模式下才会输出，用于观察限流、指标和执行耗时等内部状态。
 */
function printDebugInfo(response: GatewayResponse): void {
  if (!response.debug) {
    return;
  }

  console.log("\n[gateway debug]");
  console.log(`modelProvider: ${response.debug.modelProvider}`);
  console.log(`memoryCount: ${response.debug.memoryCount}`);
  console.log(`durationMs: ${response.debug.durationMs}`);
  console.log(`hasError: ${response.debug.hasError}`);
  if (response.debug.memorySelection) {
    console.log(
      `memorySelection: hits=${response.debug.memorySelection.hitCount}, hasRecentMemory=${response.debug.memorySelection.hasRecentMemory}`
    );
    console.log(
      `memorySources: ${JSON.stringify(response.debug.memorySelection.sourceBreakdown)}`
    );
    if (response.debug.memorySelection.topMemoryIds.length > 0) {
      console.log(
        `topMemoryIds: ${response.debug.memorySelection.topMemoryIds.join(", ")}`
      );
    }
  }
  if (response.debug.skillSelection) {
    console.log(
      `skillSelection: discovered=${response.debug.skillSelection.discoveredSkillCount}, strategy=${response.debug.skillSelection.strategy}`
    );
    if (response.debug.skillSelection.activatedSkills.length > 0) {
      console.log(
        `activeSkills: ${response.debug.skillSelection.activatedSkills.join(", ")}`
      );
    }
    if (response.debug.skillSelection.matchedSkills.length > 0) {
      console.log(
        `matchedSkills: ${response.debug.skillSelection.matchedSkills.join(", ")}`
      );
    }
  }
  if (response.debug.autoToolLoop) {
    console.log(
      `autoToolLoop: attempted=${response.debug.autoToolLoop.attempted}, toolCalls=${response.debug.autoToolLoop.toolCallCount}/${response.debug.autoToolLoop.maxSteps}, finishReason=${response.debug.autoToolLoop.finishReason}`
    );
    if (response.debug.autoToolLoop.availableTools) {
      console.log(
        `autoToolAvailable: ${response.debug.autoToolLoop.availableTools
          .map((tool) => `${tool.name}:${tool.automationLevel}/${tool.riskLevel}`)
          .join(", ")}`
      );
    }
    if (response.debug.autoToolLoop.decisionTrace) {
      response.debug.autoToolLoop.decisionTrace.forEach((trace) => {
        console.log(
          `autoToolTrace: step=${trace.step} action=${trace.action} tool=${trace.toolName ?? "-"} status=${trace.status ?? "-"} reason=${trace.reason ?? "-"} error=${trace.error ?? "-"}`
        );
      });
    }
    if (response.debug.autoToolLoop.plannerError) {
      console.log(`autoToolPlannerError: ${response.debug.autoToolLoop.plannerError}`);
    }
  }

  if (response.debug.rateLimit) {
    console.log(
      `rateLimit: remaining=${response.debug.rateLimit.remaining}/${response.debug.rateLimit.limit}, retryAfterMs=${response.debug.rateLimit.retryAfterMs}`
    );
  }

  if (response.debug.sandbox) {
    console.log(
      `sandbox: mode=${response.debug.sandbox.mode}, containerEnabled=${response.debug.sandbox.enabled ?? false}, backend=${response.debug.sandbox.backend ?? "-"}, containerMode=${response.debug.sandbox.containerMode ?? "-"}, roots=${response.debug.sandbox.allowedRoots.join(", ")}`
    );
  }

  if (response.debug.metrics) {
    console.log(
      `metrics: total=${response.debug.metrics.totalRequests}, errorRate=${response.debug.metrics.errorRate}%, p95=${response.debug.metrics.p95DurationMs}ms, circuit=${response.debug.metrics.circuitState}`
    );
  }
}

/**
 * 打印错误信息。
 *
 * 这里的错误不是程序崩溃，而是 Gateway 在兜底后决定显式暴露给操作者的失败原因。
 */
function printError(response: GatewayResponse): void {
  if (!response.error) {
    return;
  }

  console.log("\n[gateway error]");
  console.log(response.error);
}
