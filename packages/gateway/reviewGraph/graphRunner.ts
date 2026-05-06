
import * as crypto from "node:crypto";

import type { ModelProvider } from "../../model/types";
import type { ToolCallExecutor } from "../toolCallExecutor";
import type { ToolRegistry } from "../toolRegistry";
import { getAgentByNode } from "./agents";
import type {
  AgentResult,
  AgentReviewReport,
  FinalStatus,
  GraphNode,
  ImplementResult,
  PlanResult,
  ReviewGraphRunnerOptions,
  ReviewGraphState,
  ReviewerResult,
  SecurityDecision,
  SecurityResult,
  TaskType,
  TestResult,
  VerifyResult,
} from "./types";
import { SubAgentRunner, type SubAgentRunnerOptions } from "./subAgentRunner";
import { buildReport } from "./reportBuilder";

const GRAPH_NODES: GraphNode[] = [
  "explore",
  "plan",
  "implement",
  "test",
  "verify",
  "security",
  "reviewer",
];

/**
 * 函数 `generateRunId` 的职责说明。
 * `generateRunId` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function generateRunId(): string {
  return `rg_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * 函数 `detectTaskType` 的职责说明。
 * `detectTaskType` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function detectTaskType(userGoal: string): TaskType {
  const lower = userGoal.toLowerCase();
  if (
    lower.includes("fix") ||
    lower.includes("bug") ||
    lower.includes("修复") ||
    lower.includes("错误")
  ) {
    return "bugfix";
  }
  if (
    lower.includes("feature") ||
    lower.includes("add") ||
    lower.includes("implement") ||
    lower.includes("新增") ||
    lower.includes("实现")
  ) {
    return "feature";
  }
  if (
    lower.includes("refactor") ||
    lower.includes("重构") ||
    lower.includes("优化")
  ) {
    return "refactor";
  }
  if (
    lower.includes("test") ||
    lower.includes("测试")
  ) {
    return "test";
  }
  if (
    lower.includes("doc") ||
    lower.includes("文档") ||
    lower.includes("readme")
  ) {
    return "docs";
  }
  return "other";
}

export interface ReviewGraphRunInput {
  userGoal: string;
  taskType?: TaskType;
  targetFiles?: string[];
  constraints?: string[];
  maxRepairRounds?: number;
}

export interface ReviewGraphRunOutput {
  state: ReviewGraphState;
  report: AgentReviewReport;
  finalStatus: FinalStatus;
}

export class ReviewGraphRunner {
  private readonly subAgentRunner: SubAgentRunner;
  private readonly maxRepairRounds: number;
  private readonly auditLogger?: SubAgentRunnerOptions["auditLogger"];

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(
    options: SubAgentRunnerOptions & ReviewGraphRunnerOptions
  ) {
    this.subAgentRunner = new SubAgentRunner(options);
    this.maxRepairRounds = options.maxRepairRounds ?? 3;
    this.auditLogger = options.auditLogger;
  }

  /**
   * 方法 `run` 的职责说明。
   * `run` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  async run(input: ReviewGraphRunInput): Promise<ReviewGraphRunOutput> {
    const runId = generateRunId();
    const taskType = input.taskType ?? detectTaskType(input.userGoal);

    const state: ReviewGraphState = {
      runId,
      userGoal: input.userGoal,
      taskType,
      currentNode: "explore",
      targetFiles: input.targetFiles ?? [],
      constraints: input.constraints ?? [],
      repairRounds: 0,
      maxRepairRounds: input.maxRepairRounds ?? this.maxRepairRounds,
      auditRefs: [],
      startTime: Date.now(),
    };

    let currentNodeIndex = 0;

    while (currentNodeIndex < GRAPH_NODES.length) {
      const node = GRAPH_NODES[currentNodeIndex];
      state.currentNode = node;

      const agentDef = getAgentByNode(node);
      if (!agentDef) {
        state.finalStatus = "failed";
        break;
      }

      const userPrompt = this.buildNodePrompt(node, state);
      const context = this.buildNodeContext(node, state);

      const result = await this.subAgentRunner.run({
        agentDef,
        userPrompt,
        context,
        state,
      });

      state.auditRefs.push(...result.auditRefs);

      if (result.status === "error") {
        state.finalStatus = "failed";
        break;
      }

      this.updateStateWithResult(state, node, result);

      const nextAction = this.evaluateNodeResult(state, node, result);

      if (nextAction === "continue") {
        currentNodeIndex++;
      } else if (nextAction === "repair") {
        state.repairRounds++;
        if (state.repairRounds >= state.maxRepairRounds) {
          state.finalStatus = "failed";
          break;
        }
        currentNodeIndex = GRAPH_NODES.indexOf("plan");
      } else if (nextAction === "blocked") {
        state.finalStatus = "blocked";
        break;
      } else if (nextAction === "needs_approval") {
        state.finalStatus = "needs_approval";
        break;
      }
    }

    if (!state.finalStatus) {
      state.finalStatus = "passed";
    }

    state.endTime = Date.now();

    const report = buildReport(state);

    return { state, report, finalStatus: state.finalStatus };
  }

  /**
   * 方法 `buildNodePrompt` 的职责说明。
   * `buildNodePrompt` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private buildNodePrompt(node: GraphNode, state: ReviewGraphState): string {
    switch (node) {
      case "explore":
        return `Explore the codebase to understand the following task:

Goal: ${state.userGoal}
Task Type: ${state.taskType}

Find all relevant files, understand the current implementation, and provide a structured summary of your findings.`;

      case "plan":
        return `Create an implementation plan for the following task:

Goal: ${state.userGoal}
Task Type: ${state.taskType}

${state.explore ? `Exploration Results:\n${JSON.stringify(state.explore, null, 2)}` : ""}

Provide a detailed plan with target files, steps, risks, and complexity assessment.`;

      case "implement":
        return `Implement the following changes based on the plan:

Goal: ${state.userGoal}

${state.plan ? `Plan:\n${JSON.stringify(state.plan, null, 2)}` : ""}

${state.targetFiles.length > 0 ? `Target Files:\n${state.targetFiles.map((f) => `- ${f}`).join("\n")}` : ""}

Make the necessary changes and report what you modified.`;

      case "test":
        return `Run tests and validation for the implementation:

Goal: ${state.userGoal}

${state.implement ? `Changed Files:\n${state.implement.changedFiles.map((f) => `- ${f}`).join("\n")}` : ""}

Run typecheck, lint, build, and tests. Report all results.`;

      case "verify":
        return `Verify that the implementation meets the requirements:

Goal: ${state.userGoal}
Task Type: ${state.taskType}

${state.plan ? `Plan:\n${JSON.stringify(state.plan, null, 2)}` : ""}

${state.test ? `Test Results:\nOverall Passed: ${state.test.overallPassed}\nSummary: ${state.test.summary}` : ""}

Check requirement coverage, identify missing cases, and assess false pass risks.`;

      case "security":
        return `Audit the security of the implementation:

Goal: ${state.userGoal}

Tool calls made during this workflow:
${JSON.stringify(state.auditRefs, null, 2)}

${state.implement ? `Changed Files:\n${state.implement.changedFiles.map((f) => `- ${f}`).join("\n")}` : ""}

Check for sensitive file access, path traversal, dangerous commands, and chain risks.`;

      case "reviewer":
        return `Make the final delivery decision:

Goal: ${state.userGoal}
Task Type: ${state.taskType}

${state.test ? `Test Results:\nOverall Passed: ${state.test.overallPassed}\nSummary: ${state.test.summary}` : ""}

${state.verify ? `Verification:\nStatus: ${state.verify.status}\nScore: ${state.verify.score}/10\nRecommendation: ${state.verify.recommendation}` : ""}

${state.security ? `Security:\nDecision: ${state.security.decision}\nViolations: ${state.security.violations.length}` : ""}

Synthesize all results and provide your final decision.`;

      default:
        return `Execute the ${node} phase for: ${state.userGoal}`;
    }
  }

  /**
   * 方法 `buildNodeContext` 的职责说明。
   * `buildNodeContext` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private buildNodeContext(node: GraphNode, state: ReviewGraphState): string {
    const parts: string[] = [];

    if (node !== "explore" && state.explore) {
      parts.push(`## Exploration Summary\n${state.explore.summary}`);
    }

    if (node === "implement" && state.plan) {
      parts.push(`## Plan Steps\n${state.plan.steps.map((s) => `${s.id}: ${s.description}`).join("\n")}`);
    }

    if (node === "verify" && state.implement) {
      parts.push(`## Implementation Summary\n${state.implement.summary}`);
    }

    if (node === "reviewer") {
      if (state.test) parts.push(`## Test Summary\n${state.test.summary}`);
      if (state.verify) parts.push(`## Verification Summary\n${state.verify.summary}`);
      if (state.security) parts.push(`## Security Summary\n${state.security.summary}`);
    }

    return parts.join("\n\n");
  }

  /**
   * 方法 `updateStateWithResult` 的职责说明。
   * `updateStateWithResult` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private updateStateWithResult(
    state: ReviewGraphState,
    node: GraphNode,
    result: AgentResult
  ): void {
    if (result.status !== "ok") return;

    switch (node) {
      case "explore":
        state.explore = result.payload as ReviewGraphState["explore"];
        break;
      case "plan":
        state.plan = result.payload as PlanResult;
        if (state.plan.targetFiles) {
          state.targetFiles = state.plan.targetFiles;
        }
        break;
      case "implement":
        state.implement = result.payload as ImplementResult;
        break;
      case "test":
        state.test = result.payload as TestResult;
        break;
      case "verify":
        state.verify = result.payload as VerifyResult;
        break;
      case "security":
        state.security = result.payload as SecurityResult;
        break;
      case "reviewer":
        state.reviewer = result.payload as ReviewerResult;
        break;
    }
  }

  /**
   * 方法 `evaluateNodeResult` 的职责说明。
   * `evaluateNodeResult` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private evaluateNodeResult(
    state: ReviewGraphState,
    node: GraphNode,
    result: AgentResult
  ): "continue" | "repair" | "blocked" | "needs_approval" {
    if (result.status === "error") return "continue";

    switch (node) {
      case "test": {
        const testResult = state.test;
        if (testResult && !testResult.overallPassed) {
          return "repair";
        }
        return "continue";
      }

      case "verify": {
        const verifyResult = state.verify;
        if (verifyResult) {
          if (
            verifyResult.status === "fail" ||
            verifyResult.recommendation === "needs_rework"
          ) {
            return "repair";
          }
        }
        return "continue";
      }

      case "security": {
        const securityResult = state.security;
        if (securityResult) {
          if (securityResult.decision === "deny") {
            return "blocked";
          }
          if (securityResult.decision === "needs_approval") {
            return "needs_approval";
          }
        }
        return "continue";
      }

      default:
        return "continue";
    }
  }
}
