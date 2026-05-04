import * as fs from "node:fs";
import * as path from "node:path";

import { DeepSeekProvider } from "../../packages/model/deepseekProvider";
import { resolveProjectRoot } from "../../packages/core/src/config";
import { loadEnvFile } from "../../packages/gateway/env";
import { Gateway } from "../../packages/gateway/gateway";
import { ToolCallExecutor } from "../../packages/gateway/toolCallExecutor";
import { ToolRegistry } from "../../packages/gateway/toolRegistry";
import { createBuiltinToolRegistry } from "../../packages/gateway/builtinTools";
import { runLocalCommand } from "../../packages/gateway/localCommandRunner";
import { createGatewayRequest } from "../../packages/gateway/requestHandler";
import type { ChatMessage, ModelProvider, ModelResponse } from "../../packages/model/types";
import type { GatewayRequest } from "../../packages/gateway/types";

loadEnvFile();

const WORKSPACE = resolveProjectRoot();
const LOG_DIR = path.join(WORKSPACE, "logs", "api-test");

export interface ApiCallRecord {
  timestamp: string;
  callIndex: number;
  requestMessages: Array<{ role: string; contentPreview: string }>;
  responseText: string;
  responsePreview: string;
  durationMs: number;
  error?: string;
}

export class LoggingDeepSeekProvider implements ModelProvider {
  readonly name = "deepseek";
  private readonly inner: DeepSeekProvider;
  private callIndex = 0;
  private readonly records: ApiCallRecord[] = [];

  constructor() {
    this.inner = new DeepSeekProvider();
  }

  async generate(messages: ChatMessage[]): Promise<ModelResponse> {
    this.callIndex++;
    const start = Date.now();
    const requestMessages = messages.map((m) => ({
      role: m.role,
      contentPreview: String(m.content ?? "").slice(0, 300),
      contentLength: String(m.content ?? "").length,
      hasToolResults: String(m.content ?? "").includes("Executed tool calls:"),
    }));

    try {
      const result = await this.inner.generate(messages);
      const durationMs = Date.now() - start;
      const record: ApiCallRecord = {
        timestamp: new Date().toISOString(),
        callIndex: this.callIndex,
        requestMessages,
        responseText: result.text,
        responsePreview: result.text.slice(0, 500),
        durationMs,
      };
      this.records.push(record);
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const record: ApiCallRecord = {
        timestamp: new Date().toISOString(),
        callIndex: this.callIndex,
        requestMessages,
        responseText: "",
        responsePreview: "",
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      };
      this.records.push(record);
      throw err;
    }
  }

  getRecords(): ApiCallRecord[] {
    return [...this.records];
  }

  writeLog(testName: string): void {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const safeName = testName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
    const filePath = path.join(LOG_DIR, `${safeName}.json`);
    const summary = {
      testName,
      totalCalls: this.callIndex,
      totalDurationMs: this.records.reduce((s, r) => s + r.durationMs, 0),
      records: this.records,
    };
    fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), "utf-8");
  }
}

export function createRealApiGateway(opts?: {
  maxSteps?: number;
  maxFixRounds?: number;
}): { gateway: Gateway; provider: LoggingDeepSeekProvider; registry: ToolRegistry } {
  const provider = new LoggingDeepSeekProvider();
  const registry = createBuiltinToolRegistry({
    memorySearch: async () => [],
    memoryTopK: 5,
    projectRoot: WORKSPACE,
  });

  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: provider,
    toolRegistry: registry,
    toolCallExecutor: new ToolCallExecutor({ registry, projectRoot: WORKSPACE, allowBypassPermissions: true }),
    debug: true,
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: opts?.maxSteps ?? 10,
    devTaskMaxFixRounds: opts?.maxFixRounds ?? 3,
  });

  return { gateway, provider, registry };
}

export function bypassRequest(input: string, opts?: { sessionId?: string }): GatewayRequest {
  return createGatewayRequest(input, {
    permissionMode: "bypassPermissions",
    sessionId: opts?.sessionId,
  });
}

export { WORKSPACE };
