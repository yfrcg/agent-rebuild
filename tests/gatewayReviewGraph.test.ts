import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../packages/gateway/gateway";
import type { GatewayOptions } from "../packages/gateway/gateway";
import type { GatewayRequest, GatewayResponse } from "../packages/gateway/types";
import type { ModelProvider, ModelResponse, ChatMessage } from "../packages/model/types";
import type { ToolCallExecutor } from "../packages/gateway/toolCallExecutor";
import type { ToolRegistry } from "../packages/gateway/toolRegistry";
import type { GatewayToolCallRecord } from "../packages/gateway/toolCallTypes";

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

function makeToolCallExecutor(): ToolCallExecutor {
  return {
    execute: async (req: { toolName: string }): Promise<GatewayToolCallRecord> =>
      makeSuccessRecord(req.toolName),
  } as unknown as ToolCallExecutor;
}

function makeModelProvider(responseText: string): ModelProvider {
  return {
    name: "mock-model",
    generate: async (_messages: ChatMessage[]): Promise<ModelResponse> => {
      return { text: responseText };
    },
  } as unknown as ModelProvider;
}

function makeReviewGraphResponses(): string[] {
  return [
    makeFinalResp({ relevantFiles: [], evidence: [], codeStructure: {}, dependencies: [], summary: "explore" }),
    makeFinalResp({ targetFiles: [], steps: [], risks: [], requiresApproval: false, estimatedComplexity: "low", summary: "plan" }),
    makeFinalResp({ changedFiles: [], diffSummary: "", changes: [], summary: "impl" }),
    makeFinalResp({ overallPassed: true, tests: [], typecheck: { name: "TypeCheck", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, lint: { name: "Lint", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, build: { name: "Build", passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, summary: "ok" }),
    makeFinalResp({ status: "pass", score: 8, requirementCoverage: [], missingCases: [], falsePassRisks: [], recommendation: "pass", suggestions: [], summary: "ok" }),
    makeFinalResp({ decision: "allow", violations: [], auditFindings: [], chainRisks: [], summary: "ok" }),
    makeFinalResp({ finalDecision: "approved", approved: true, blockingIssues: [], warnings: [], suggestions: [], testSummary: "", verifySummary: "", securitySummary: "", summary: "ok" }),
  ];
}

function makeFinalResp(data: Record<string, unknown>): string {
  return JSON.stringify({ type: "final", content: JSON.stringify(data) });
}

function makeSequentialModelProvider(responses: string[]): ModelProvider {
  let callIndex = 0;
  return {
    name: "mock-model",
    generate: async (_messages: ChatMessage[]): Promise<ModelResponse> => {
      const text = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return { text };
    },
  } as unknown as ModelProvider;
}

describe("Gateway ReviewGraph integration", () => {
  it("does not use ReviewGraph when autoReviewGraphEnabled=false", async () => {
    const modelProvider = makeModelProvider("Hello! How can I help?");
    const memorySearch = async () => [];

    const gateway = new Gateway({
      memorySearch,
      modelProvider,
      autoReviewGraphEnabled: false,
    });

    const response = await gateway.handle({
      id: "test-1",
      input: "fix the broken test in auth module",
      text: "fix the broken test in auth module",
    });

    assert.ok(response.text);
    assert.ok(!response.text.includes("AgentReview Graph"));
  });

  it("uses ReviewGraph for dev task when enabled", async () => {
    const responses = makeReviewGraphResponses();
    const modelProvider = makeSequentialModelProvider(responses);
    const memorySearch = async () => [];

    const gateway = new Gateway({
      memorySearch,
      modelProvider,
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      autoReviewGraphEnabled: true,
    });

    const response = await gateway.handle({
      id: "test-2",
      input: "fix the broken authentication module and update the test",
      text: "fix the broken authentication module and update the test",
    });

    assert.ok(response.text.includes("AgentReview Graph"));
    assert.ok(response.text.includes("PASSED") || response.text.includes("passed"));
  });

  it("does not use ReviewGraph for casual conversation", async () => {
    const modelProvider = makeModelProvider("Hi there! How can I help?");
    const memorySearch = async () => [];

    const gateway = new Gateway({
      memorySearch,
      modelProvider,
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      autoReviewGraphEnabled: true,
    });

    const response = await gateway.handle({
      id: "test-3",
      input: "what is the weather today?",
      text: "what is the weather today?",
    });

    assert.ok(!response.text.includes("AgentReview Graph"));
  });

  it("does not use ReviewGraph for short input", async () => {
    const modelProvider = makeModelProvider("ok");
    const memorySearch = async () => [];

    const gateway = new Gateway({
      memorySearch,
      modelProvider,
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      autoReviewGraphEnabled: true,
    });

    const response = await gateway.handle({
      id: "test-4",
      input: "hi",
      text: "hi",
    });

    assert.ok(!response.text.includes("AgentReview Graph"));
  });

  it("does not use ReviewGraph for questions", async () => {
    const modelProvider = makeModelProvider("Here's how to use it...");
    const memorySearch = async () => [];

    const gateway = new Gateway({
      memorySearch,
      modelProvider,
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      autoReviewGraphEnabled: true,
    });

    const response = await gateway.handle({
      id: "test-5",
      input: "implement the new authentication feature?",
      text: "implement the new authentication feature?",
    });

    assert.ok(!response.text.includes("AgentReview Graph"));
  });

  it("uses ReviewGraph for Chinese dev tasks", async () => {
    const responses = makeReviewGraphResponses();
    const modelProvider = makeSequentialModelProvider(responses);
    const memorySearch = async () => [];

    const gateway = new Gateway({
      memorySearch,
      modelProvider,
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      autoReviewGraphEnabled: true,
    });

    const response = await gateway.handle({
      id: "test-6",
      input: "修复登录模块的认证错误并添加新的测试用例",
      text: "修复登录模块的认证错误并添加新的测试用例",
    });

    assert.ok(response.text.includes("AgentReview Graph"));
  });

  it("handles ReviewGraph errors gracefully", async () => {
    const errorModelProvider: ModelProvider = {
      name: "error-model",
      generate: async (): Promise<ModelResponse> => {
        throw new Error("Model unavailable");
      },
    } as unknown as ModelProvider;

    const memorySearch = async () => [];

    const gateway = new Gateway({
      memorySearch,
      modelProvider: errorModelProvider,
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      autoReviewGraphEnabled: true,
    });

    const response = await gateway.handle({
      id: "test-7",
      input: "fix the broken test in the authentication module",
      text: "fix the broken test in the authentication module",
    });

    assert.ok(response.text);
    assert.ok(response.error || response.text.includes("失败") || response.text.includes("AgentReview Graph"));
  });

  it("maintains normal flow when toolRegistry not provided", async () => {
    const modelProvider = makeModelProvider("Normal response");
    const memorySearch = async () => [];

    const gateway = new Gateway({
      memorySearch,
      modelProvider,
      autoReviewGraphEnabled: true,
    });

    const response = await gateway.handle({
      id: "test-8",
      input: "fix the broken authentication module test",
      text: "fix the broken authentication module test",
    });

    assert.ok(response.text);
    assert.ok(!response.text.includes("AgentReview Graph"));
  });

  it("maintains normal flow when toolCallExecutor not provided", async () => {
    const modelProvider = makeModelProvider("Normal response");
    const memorySearch = async () => [];

    const gateway = new Gateway({
      memorySearch,
      modelProvider,
      toolRegistry: makeToolRegistry(),
      autoReviewGraphEnabled: true,
    });

    const response = await gateway.handle({
      id: "test-9",
      input: "fix the broken authentication module test",
      text: "fix the broken authentication module test",
    });

    assert.ok(response.text);
    assert.ok(!response.text.includes("AgentReview Graph"));
  });

  it("preserves requestId in response", async () => {
    const responses = makeReviewGraphResponses();
    const modelProvider = makeSequentialModelProvider(responses);
    const memorySearch = async () => [];

    const gateway = new Gateway({
      memorySearch,
      modelProvider,
      toolRegistry: makeToolRegistry(),
      toolCallExecutor: makeToolCallExecutor(),
      autoReviewGraphEnabled: true,
    });

    const response = await gateway.handle({
      id: "req-123",
      input: "implement the new logging feature for production",
      text: "implement the new logging feature for production",
    });

    assert.equal(response.id, "req-123");
  });
});
