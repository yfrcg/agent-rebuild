
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

import { printBootstrapStatus } from "../../../packages/gateway/bootstrapPrinter";
import { parseGatewayCommand } from "../../../packages/gateway/commandParser";
import { printGatewayResponse } from "../../../packages/gateway/outputPrinter";
import { createGatewayRequest } from "../../../packages/gateway/requestHandler";
import { printGatewayHelp } from "../../../packages/gateway/replHelp";
import { askReplInput } from "../../../packages/gateway/replInput";
import { handleBuiltInGatewayCommand } from "../../../packages/gateway/replCommandHandlers";
import { createGatewayRuntime } from "../../../packages/gateway/runtime";
import { printRuntimeConfig } from "../../../packages/gateway/runtimeConfigPrinter";
import { maybeAutoCompactSession } from "../../../packages/gateway/sessionAutoCompaction";
import { recordTranscript } from "../../../packages/gateway/transcriptRecorder";

process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[gateway] uncaughtException:", err);
  process.exit(1);
});

/**
 * 函数 `main` 的职责说明。
 * `main` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function main(): Promise<void> {
  const runtime = await createGatewayRuntime();
  const {
    config,
    gateway,
    sessionManager,
    toolRegistry,
    toolCallExecutor,
    mcpManager,
    sandbox,
    auditLogger,
  } = runtime;

  printBootstrapStatus();
  printRuntimeConfig(config);
  printGatewayHelp();
  console.log(`[gateway] model provider: ${config.model}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  /** 函数变量 `maybeRunSessionCompaction`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
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

      const raw = rawInput.trim();
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
        sandbox,
        auditLogger,
        confirmTokenTtlMs: config.confirmTokenTtlMs,
        rl,
      });

      if (commandResult.shouldExit) {
        break;
      }

      if (commandResult.handled) {
        maybeRunSessionCompaction();
        continue;
      }

      const currentSession = sessionManager.getCurrentSession();
      const request = createGatewayRequest(command.payload ?? command.raw, {
        sessionId: sessionManager.getCurrentSessionId(),
        activeSkills: currentSession.activeSkills ?? [],
        permissionMode: currentSession.permissionMode ?? "default",
        planState: currentSession.planState,
      });
      const response = await gateway.handle(request);

      printGatewayResponse(response);

      const sessionAfterResponse = sessionManager.getCurrentSession();
      if (sessionAfterResponse.permissionMode === "plan" && sessionAfterResponse.planState?.active) {
        const updatedPlan = {
          ...sessionAfterResponse.planState,
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

      const activeSessionId = sessionManager.getCurrentSessionId();
      recordTranscript(activeSessionId, "assistant", response.text);
      sessionManager.incrementCurrentSessionMessageCount();
      maybeRunSessionCompaction();
    }
  } finally {
    rl.close();
    await runtime.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
