/**
 * ?????CS336 ???
 * ???tests/helpers/realApiTestHelper.ts
 * ????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { TokenPlanProvider } from "../../packages/model/tokenPlanProvider";
import { resolveProjectRoot } from "../../packages/core/src/config";
import { loadEnvFile } from "../../packages/gateway/env";
import { Gateway } from "../../packages/gateway/gateway";
import { ToolCallExecutor } from "../../packages/gateway/toolCallExecutor";
import { ToolRegistry } from "../../packages/gateway/toolRegistry";
import { createBuiltinToolRegistry } from "../../packages/gateway/builtinTools";
import { createGatewayRequest } from "../../packages/gateway/requestHandler";
import type { ChatMessage, ModelProvider, ModelResponse } from "../../packages/model/types";
import type { GatewayRequest } from "../../packages/gateway/types";

loadEnvFile();

const WORKSPACE = resolveProjectRoot();
const LOG_DIR = path.join(WORKSPACE, "logs", "api-test");

export function shouldRunRealApiTests(): boolean {
  return process.env.RUN_LIVE_API_TESTS === "1" && Boolean(
    process.env.TOKENPLAN_API_KEY?.trim() ||
    process.env.MINIMAX_TOKENPLAN_API_KEY?.trim() ||
    process.env.MINIMAX_API_KEY?.trim()
  );
}

export interface ApiCallRecord {
  timestamp: string;
  callIndex: number;
  requestMessages: Array<{ role: string; contentPreview: string }>;
  responseText: string;
  responsePreview: string;
  durationMs: number;
  error?: string;
}

export class LoggingLiveProvider implements ModelProvider {
  readonly name = "tokenplan";
  private readonly inner: TokenPlanProvider;
  private callIndex = 0;
  private readonly records: ApiCallRecord[] = [];

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor() {
    this.inner = new TokenPlanProvider();
  }

  /**
   * 方法 `generate` 的职责说明。
   * `generate` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

  /**
   * 方法 `getRecords` 的职责说明。
   * `getRecords` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  getRecords(): ApiCallRecord[] {
    return [...this.records];
  }

  /**
   * 方法 `writeLog` 的职责说明。
   * `writeLog` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
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

/**
 * 函数 `createRealApiGateway` 的职责说明。
 * `createRealApiGateway` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createRealApiGateway(opts?: {
  maxSteps?: number;
  maxFixRounds?: number;
}): { gateway: Gateway; provider: LoggingLiveProvider; registry: ToolRegistry } {
  const provider = new LoggingLiveProvider();
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

/**
 * 函数 `bypassRequest` 的职责说明。
 * `bypassRequest` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function bypassRequest(input: string, opts?: { sessionId?: string }): GatewayRequest {
  return createGatewayRequest(input, {
    permissionMode: "bypassPermissions",
    sessionId: opts?.sessionId,
  });
}

export { WORKSPACE };
