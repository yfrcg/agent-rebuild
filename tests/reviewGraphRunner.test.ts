/**
 * ?????CS336 ???
 * ???tests/reviewGraphRunner.test.ts
 * ????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ReviewGraphRunner } from "../packages/gateway/reviewGraph/graphRunner";
import type { ReviewGraphRunOutput } from "../packages/gateway/reviewGraph/graphRunner";
import type {
  AgentResult,
  AgentDefinition,
  ReviewGraphState,
  TestResult,
  VerifyResult,
  SecurityResult,
  ReviewerResult,
} from "../packages/gateway/reviewGraph/types";
import type { ModelProvider, ModelResponse, ChatMessage } from "../packages/model/types";
import type { ToolCallExecutor } from "../packages/gateway/toolCallExecutor";
import type { ToolRegistry } from "../packages/gateway/toolRegistry";
import type { GatewayToolCallRecord } from "../packages/gateway/toolCallTypes";

/**
 * 函数 `makeSuccessRecord` 的职责说明。
 * `makeSuccessRecord` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function makeSuccessRecord(toolName: string): GatewayToolCallRecord {
  return {
    id: `rec_${Date.now()}`,
    toolName,
    input: {},
    status: "success" as const,
    output: { content: `ok: ${toolName}` },
    createdAt: new Date().toISOString(),
  };
}

/**
 * 函数 `makeToolRegistry` 的职责说明。
 * `makeToolRegistry` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function makeToolRegistry(): ToolRegistry {
  const toolNames = [
    "file.read", "file.glob", "file.grep", "file.list",
    "file.write", "file.edit", "file.multi_edit", "file.patch",
    "git.status", "git.diff", "git.commit",
    "shell.run", "bash.run",
    "typecheck.run", "lint.run", "verify.run",
    "npm_test", "run_test", "build",
    "memory.search", "memory.write",
    "web.fetch", "web.search",
    "audit.query", "policy.check",
  ];

  return {
    get: (name: string) => ({
      name,
      description: `Tool ${name}`,
      invoke: async () => ({ ok: true, content: `executed ${name}` }),
      riskLevel: "low" as const,
    }),
    list: () => toolNames.map((n) => ({ name: n, description: n })),
    has: (name: string) => toolNames.includes(name),
  } as unknown as ToolRegistry;
}

/**
 * 函数 `makeToolCallExecutor` 的职责说明。
 * `makeToolCallExecutor` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function makeToolCallExecutor(): ToolCallExecutor {
  return {
    execute: async (req: { toolName: string }): Promise<GatewayToolCallRecord> =>
      makeSuccessRecord(req.toolName),
  } as unknown as ToolCallExecutor;
}

/**
 * 函数 `makeModelProvider` 的职责说明。
 * `makeModelProvider` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function makeModelProvider(responseTexts: string[]): ModelProvider {
  let callIndex = 0;
  return {
    name: "mock-model",
    generate: async (_messages: ChatMessage[]): Promise<ModelResponse> => {
      const text = responseTexts[Math.min(callIndex, responseTexts.length - 1)];
      callIndex++;
      return { text };
    },
  } as unknown as ModelProvider;
}

/**
 * 函数 `makeFinalResponse` 的职责说明。
 * `makeFinalResponse` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function makeFinalResponse(data: Record<string, unknown>): string {
  return JSON.stringify({ type: "final", content: JSON.stringify(data) });
}

describe("ReviewGraphRunner", () => {
  it("runs full explore → plan → implement → test → verify → security → reviewer pipeline", async () => {
    const responses = [
      makeFinalResponse({
        relevantFiles: ["src/a.ts"],
        evidence: ["found function foo"],
        codeStructure: { files: ["src/a.ts"] },
        dependencies: [],
        summary: "Found relevant code in src/a.ts",
      }),
      makeFinalResponse({
        targetFiles: ["src/a.ts"],
        steps: [{ id: "1", description: "Update function foo", targetFiles: ["src/a.ts"], expectedChanges: ["modify return"], risks: [] }],
        risks: [],
        requiresApproval: false,
        estimatedComplexity: "low",
        summary: "Plan to update function foo",
      }),
      makeFinalResponse({
        changedFiles: ["src/a.ts"],
        diffSummary: "modified 1 file",
        changes: [{ file: "src/a.ts", additions: 3, deletions: 1, summary: "updated return value" }],
        summary: "Implemented changes in src/a.ts",
      }),
      makeFinalResponse({
        overallPassed: true,
        tests: [],
        typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 100 },
        lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 50 },
        build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 200 },
        summary: "All tests passed",
      }),
      makeFinalResponse({
        status: "pass",
        score: 9,
        requirementCoverage: [{ requirement: "update return", covered: true }],
        missingCases: [],
        falsePassRisks: [],
        recommendation: "pass",
        suggestions: [],
        summary: "Implementation meets requirements",
      }),
      makeFinalResponse({
        decision: "allow",
        violations: [],
        auditFindings: [],
        chainRisks: [],
        summary: "No security issues found",
      }),
      makeFinalResponse({
        finalDecision: "approved",
        approved: true,
        blockingIssues: [],
        warnings: [],
        suggestions: ["Consider adding more tests"],
        testSummary: "All tests passed",
        verifySummary: "Score 9/10",
        securitySummary: "No violations",
        summary: "Approved for delivery",
      }),
    ];

    const runner = new ReviewGraphRunner({
      modelProvider: makeModelProvider(responses),
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      workspaceRoot: process.cwd(),
    });

    const result = await runner.run({
      userGoal: "fix the broken return value in function foo",
    });

    assert.equal(result.finalStatus, "passed");
    assert.ok(result.report);
    assert.equal(result.report.userGoal, "fix the broken return value in function foo");
    assert.equal(result.report.taskType, "bugfix");
    assert.ok(result.report.agentChain.length >= 5);
    assert.equal(result.report.finalStatus, "passed");
    assert.equal(result.report.repairRounds, 0);
  });

  it("detects taskType as feature", async () => {
    const responses = [
      makeFinalResponse({ relevantFiles: [], evidence: [], codeStructure: {}, dependencies: [], summary: "empty" }),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "no plan" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "no changes" }),
      makeFinalResponse({
        overallPassed: true, tests: [],
        typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        summary: "ok",
      }),
      makeFinalResponse({ status: "pass", score: 8, requirementCoverage: [], missingCases: [], falsePassRisks: [], recommendation: "pass", suggestions: [], summary: "ok" }),
      makeFinalResponse({ decision: "allow", violations: [], auditFindings: [], chainRisks: [], summary: "ok" }),
      makeFinalResponse({ finalDecision: "approved", approved: true, blockingIssues: [], warnings: [], suggestions: [], testSummary: "", verifySummary: "", securitySummary: "", summary: "ok" }),
    ];

    const runner = new ReviewGraphRunner({
      modelProvider: makeModelProvider(responses),
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      workspaceRoot: process.cwd(),
    });

    const result = await runner.run({
      userGoal: "add a new feature for user authentication",
    });

    assert.equal(result.state.taskType, "feature");
  });

  it("detects taskType as refactor", async () => {
    const responses = [
      makeFinalResponse({ relevantFiles: [], evidence: [], codeStructure: {}, dependencies: [], summary: "" }),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "medium", summary: "" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "" }),
      makeFinalResponse({ overallPassed: true, tests: [], typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, summary: "" }),
      makeFinalResponse({ status: "pass", score: 8, requirementCoverage: [], missingCases: [], falsePassRisks: [], recommendation: "pass", suggestions: [], summary: "" }),
      makeFinalResponse({ decision: "allow", violations: [], auditFindings: [], chainRisks: [], summary: "" }),
      makeFinalResponse({ finalDecision: "approved", approved: true, blockingIssues: [], warnings: [], suggestions: [], testSummary: "", verifySummary: "", securitySummary: "", summary: "" }),
    ];

    const runner = new ReviewGraphRunner({
      modelProvider: makeModelProvider(responses),
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      workspaceRoot: process.cwd(),
    });

    const result = await runner.run({ userGoal: "refactor the database module for better performance" });
    assert.equal(result.state.taskType, "refactor");
  });

  it("handles security deny → blocked", async () => {
    let callCount = 0;
    const responses = [
      makeFinalResponse({ relevantFiles: [], evidence: [], codeStructure: {}, dependencies: [], summary: "" }),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "" }),
      makeFinalResponse({ overallPassed: true, tests: [], typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, summary: "" }),
      makeFinalResponse({ status: "pass", score: 8, requirementCoverage: [], missingCases: [], falsePassRisks: [], recommendation: "pass", suggestions: [], summary: "" }),
      makeFinalResponse({
        decision: "deny",
        violations: [{ type: "sensitive_file", severity: "block", detail: "Access to .env detected" }],
        auditFindings: ["Sensitive file access attempt"],
        chainRisks: [],
        summary: "Security violation detected",
      }),
    ];

    const runner = new ReviewGraphRunner({
      modelProvider: makeModelProvider(responses),
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      workspaceRoot: process.cwd(),
    });

    const result = await runner.run({ userGoal: "fix the configuration loader" });
    assert.equal(result.finalStatus, "blocked");
  });

  it("handles security needs_approval → needs_approval", async () => {
    const responses = [
      makeFinalResponse({ relevantFiles: [], evidence: [], codeStructure: {}, dependencies: [], summary: "" }),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "" }),
      makeFinalResponse({ overallPassed: true, tests: [], typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, summary: "" }),
      makeFinalResponse({ status: "pass", score: 8, requirementCoverage: [], missingCases: [], falsePassRisks: [], recommendation: "pass", suggestions: [], summary: "" }),
      makeFinalResponse({
        decision: "needs_approval",
        violations: [{ type: "network_access", severity: "warn", detail: "External API call detected" }],
        auditFindings: [],
        chainRisks: [],
        summary: "Needs human approval for network access",
      }),
    ];

    const runner = new ReviewGraphRunner({
      modelProvider: makeModelProvider(responses),
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      workspaceRoot: process.cwd(),
    });

    const result = await runner.run({ userGoal: "fix the API integration" });
    assert.equal(result.finalStatus, "needs_approval");
  });

  it("handles test failure → repair loop", async () => {
    const failTestResult: TestResult = {
      overallPassed: false,
      tests: [{ name: "test-1", passed: false, exitCode: 1, stdout: "", stderr: "fail", timedOut: false, durationMs: 100, failureReason: "assertion error" }],
      typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      summary: "1 test failed",
    };

    const passTestResult: TestResult = {
      overallPassed: true,
      tests: [],
      typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      summary: "All tests passed",
    };

    let testCallCount = 0;
    const responses: string[] = [
      makeFinalResponse({ relevantFiles: [], evidence: [], codeStructure: {}, dependencies: [], summary: "" }),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "" }),
      makeFinalResponse(failTestResult),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "repair plan" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "repaired" }),
      makeFinalResponse(passTestResult),
      makeFinalResponse({ status: "pass", score: 8, requirementCoverage: [], missingCases: [], falsePassRisks: [], recommendation: "pass", suggestions: [], summary: "" }),
      makeFinalResponse({ decision: "allow", violations: [], auditFindings: [], chainRisks: [], summary: "" }),
      makeFinalResponse({ finalDecision: "approved", approved: true, blockingIssues: [], warnings: [], suggestions: [], testSummary: "", verifySummary: "", securitySummary: "", summary: "" }),
    ];

    const runner = new ReviewGraphRunner({
      modelProvider: makeModelProvider(responses),
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      workspaceRoot: process.cwd(),
    });

    const result = await runner.run({ userGoal: "fix the failing test" });
    assert.equal(result.state.repairRounds, 1);
    assert.equal(result.finalStatus, "passed");
  });

  it("handles verify failure → repair loop", async () => {
    const responses: string[] = [
      makeFinalResponse({ relevantFiles: [], evidence: [], codeStructure: {}, dependencies: [], summary: "" }),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "" }),
      makeFinalResponse({ overallPassed: true, tests: [], typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, summary: "ok" }),
      makeFinalResponse({ status: "fail", score: 3, requirementCoverage: [{ requirement: "r1", covered: false }], missingCases: ["edge case"], falsePassRisks: [], recommendation: "needs_rework", suggestions: ["fix edge case"], summary: "Missing coverage" }),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "replan" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "reimpl" }),
      makeFinalResponse({ overallPassed: true, tests: [], typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, summary: "ok" }),
      makeFinalResponse({ status: "pass", score: 9, requirementCoverage: [], missingCases: [], falsePassRisks: [], recommendation: "pass", suggestions: [], summary: "ok" }),
      makeFinalResponse({ decision: "allow", violations: [], auditFindings: [], chainRisks: [], summary: "" }),
      makeFinalResponse({ finalDecision: "approved", approved: true, blockingIssues: [], warnings: [], suggestions: [], testSummary: "", verifySummary: "", securitySummary: "", summary: "" }),
    ];

    const runner = new ReviewGraphRunner({
      modelProvider: makeModelProvider(responses),
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      workspaceRoot: process.cwd(),
    });

    const result = await runner.run({ userGoal: "implement the missing edge case" });
    assert.equal(result.state.repairRounds, 1);
    assert.equal(result.finalStatus, "passed");
  });

  it("fails after maxRepairRounds exceeded", async () => {
    const failTestResult = {
      overallPassed: false,
      tests: [{ name: "t1", passed: false, exitCode: 1, stdout: "", stderr: "", timedOut: false, durationMs: 0 }],
      typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
      summary: "fail",
    };

    const responses: string[] = [
      makeFinalResponse({ relevantFiles: [], evidence: [], codeStructure: {}, dependencies: [], summary: "" }),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "" }),
      makeFinalResponse(failTestResult),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "" }),
      makeFinalResponse(failTestResult),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "" }),
      makeFinalResponse(failTestResult),
      makeFinalResponse({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "" }),
      makeFinalResponse({ changedFiles: [], diffSummary: "", changes: [], summary: "" }),
      makeFinalResponse(failTestResult),
    ];

    const runner = new ReviewGraphRunner({
      modelProvider: makeModelProvider(responses),
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      workspaceRoot: process.cwd(),
      maxRepairRounds: 2,
    });

    const result = await runner.run({ userGoal: "fix something impossible" });
    assert.equal(result.finalStatus, "failed");
    assert.ok(result.state.repairRounds >= 2);
  });

  it("generates report with all fields", async () => {
    const responses = [
      makeFinalResponse({ relevantFiles: ["src/a.ts"], evidence: ["e1"], codeStructure: {}, dependencies: [], summary: "explore done" }),
      makeFinalResponse({ targetFiles: ["src/a.ts"], steps: [{ id: "1", description: "d", targetFiles: ["src/a.ts"], expectedChanges: [], risks: [] }], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "plan done" }),
      makeFinalResponse({ changedFiles: ["src/a.ts"], diffSummary: "1 file", changes: [{ file: "src/a.ts", additions: 1, deletions: 0, summary: "add" }], summary: "impl done" }),
      makeFinalResponse({ overallPassed: true, tests: [], typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, summary: "tests ok" }),
      makeFinalResponse({ status: "pass", score: 10, requirementCoverage: [{ requirement: "r1", covered: true }], missingCases: [], falsePassRisks: [], recommendation: "pass", suggestions: [], summary: "verified" }),
      makeFinalResponse({ decision: "allow", violations: [], auditFindings: [], chainRisks: [], summary: "secure" }),
      makeFinalResponse({ finalDecision: "approved", approved: true, blockingIssues: [], warnings: [], suggestions: ["add docs"], testSummary: "ok", verifySummary: "10/10", securitySummary: "clean", summary: "approved" }),
    ];

    const runner = new ReviewGraphRunner({
      modelProvider: makeModelProvider(responses),
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      workspaceRoot: process.cwd(),
    });

    const result = await runner.run({ userGoal: "add a logging feature" });

    assert.ok(result.report.runId);
    assert.equal(result.report.userGoal, "add a logging feature");
    assert.equal(result.report.taskType, "feature");
    assert.ok(result.report.agentChain.length >= 5);
    assert.deepEqual(result.report.changedFiles, ["src/a.ts"]);
    assert.equal(result.report.testResult.overallPassed, true);
    assert.equal(result.report.verifyResult.score, 10);
    assert.equal(result.report.securityResult.decision, "allow");
    assert.equal(result.report.reviewerResult.approved, true);
    assert.equal(result.report.finalStatus, "passed");
    assert.ok(result.report.totalDurationMs >= 0);
    assert.ok(result.report.suggestions.length >= 0);
  });
});
