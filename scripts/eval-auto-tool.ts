
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { Gateway } from "../packages/gateway/gateway";
import { loadGatewayConfig } from "../packages/gateway/config";
import { createModelProvider } from "../packages/gateway/modelProviderFactory";
import { ToolCallExecutor } from "../packages/gateway/toolCallExecutor";
import { ToolRegistry } from "../packages/gateway/toolRegistry";
import { createGatewayRequest } from "../packages/gateway/requestHandler";

type ExpectedTool = "none" | "memory.search" | `mcp.${string}`;

interface EvalCase {
  id: string;
  input: string;
  expected: ExpectedTool;
}

interface EvalCaseFile {
  cases: EvalCase[];
}

/**
 * 函数 `main` 的职责说明。
 * `main` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const provider = createModelProvider(config.model);
  const cases = loadEvalCases();

  const registry = new ToolRegistry();
  registry.register({
    name: "memory.search",
    description: "Search indexed memory by query text.",
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
    },
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input) {
      return {
        ok: true,
        content: [
          {
            id: "eval-memory-hit",
            content: `memory hit for query: ${String(input.query ?? "")}`,
            source: "eval-memory",
            score: 1,
          },
        ],
      };
    },
  });

  registry.register({
    name: "mcp.eval.search_projects",
    description: "Search external project examples.",
    policy: {
      automationLevel: "auto",
      riskLevel: "external-read",
    },
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
    async invoke(input) {
      return {
        ok: true,
        content: {
          query: String(input.query ?? ""),
          results: [
            {
              title: "Example Project",
              source: "eval-mcp",
            },
          ],
        },
      };
    },
  });

  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: provider,
    toolRegistry: registry,
    toolCallExecutor: new ToolCallExecutor({ registry }),
    debug: true,
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: config.autoToolLoopMaxSteps,
  });

  const results = [];

  for (const evalCase of cases) {
    const response = await gateway.handle(createGatewayRequest(evalCase.input));
    const actual = response.toolCalls?.[0]?.toolName ?? "none";
    const passed = matchesExpectation(evalCase.expected, actual);

    results.push({
      id: evalCase.id,
      expected: evalCase.expected,
      actual,
      passed,
      finishReason: response.debug?.autoToolLoop?.finishReason ?? "unknown",
    });
  }

  const passedCount = results.filter((result) => result.passed).length;
  const falsePositives = results.filter(
    (result) => result.expected === "none" && result.actual !== "none"
  ).length;
  const falseNegatives = results.filter(
    (result) => result.expected !== "none" && result.actual === "none"
  ).length;

  console.log("[eval:auto-tool]");
  console.log(
    JSON.stringify(
      {
        modelProvider: provider.name,
        caseCount: results.length,
        passedCount,
        passRate: `${((passedCount / Math.max(1, results.length)) * 100).toFixed(1)}%`,
        falsePositives,
        falseNegatives,
        results,
      },
      null,
      2
    )
  );

  if (provider.name === "mock") {
    console.warn(
      "[eval:auto-tool] current model provider is mock; use GATEWAY_MODEL=deepseek for meaningful planner evaluation."
    );
  }
}

/**
 * 函数 `loadEvalCases` 的职责说明。
 * `loadEvalCases` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function loadEvalCases(): EvalCase[] {
  const configuredPath =
    process.env.GATEWAY_EVAL_CASES_PATH ??
    path.join(process.cwd(), "config", "gateway.eval.json");
  const fallbackPath = path.join(process.cwd(), "config", "gateway.eval.example.json");
  const filePath = existsSync(configuredPath) ? configuredPath : fallbackPath;

  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as EvalCaseFile;

  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`No evaluation cases found in ${filePath}`);
  }

  return parsed.cases;
}

/**
 * 函数 `matchesExpectation` 的职责说明。
 * `matchesExpectation` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function matchesExpectation(expected: ExpectedTool, actual: string): boolean {
  if (expected === "none") {
    return actual === "none";
  }

  return actual === expected;
}

main().catch((error) => {
  console.error("[eval:auto-tool] failed");
  console.error(error);
  process.exitCode = 1;
});
