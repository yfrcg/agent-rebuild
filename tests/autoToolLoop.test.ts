import test from "node:test";
import assert from "node:assert/strict";

import { Gateway } from "../packages/gateway/gateway";
import { createGatewayRequest } from "../packages/gateway/requestHandler";
import { ToolCallExecutor } from "../packages/gateway/toolCallExecutor";
import { ToolRegistry } from "../packages/gateway/toolRegistry";
import type {
  GatewayToolCallRecord,
  GatewayToolCallRequest,
} from "../packages/gateway/toolCallTypes";
import type { ChatMessage, ModelProvider, ModelResponse } from "../packages/model/types";

class ScriptedToolLoopProvider implements ModelProvider {
  name = "scripted-tool-loop";
  private decisionCount = 0;

  async generate(messages: ChatMessage[]): Promise<ModelResponse> {
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;

    if (lastUserMessage?.includes("[AUTO_TOOL_DECISION]")) {
      this.decisionCount += 1;

      if (this.decisionCount === 1) {
        return {
          text: JSON.stringify({
            action: "tool",
            toolName: "memory.search",
            input: {
              query: "alpha project",
              topK: 1,
            },
            reason: "Need local indexed facts before answering.",
          }),
        };
      }

      return {
        text: JSON.stringify({
          action: "respond",
          reason: "Tool results are sufficient.",
        }),
      };
    }

    return {
      text: "final answer based on tool results",
    };
  }
}

class InvalidPlannerProvider implements ModelProvider {
  name = "invalid-planner";

  async generate(messages: ChatMessage[]): Promise<ModelResponse> {
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;

    if (lastUserMessage?.includes("[AUTO_TOOL_DECISION]")) {
      return {
        text: "this is not valid json",
      };
    }

    return {
      text: "fallback answer without auto tool loop",
    };
  }
}

test("Gateway auto tool loop can execute memory.search before answering", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "memory.search",
    description: "Search memory",
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    async invoke(input) {
      assert.equal(input.query, "alpha project");
      return {
        ok: true,
        content: [
          {
            id: "mem-alpha-1",
            content: "alpha project is the target memory hit",
            source: "memory-test",
          },
        ],
      };
    },
  });

  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: new ScriptedToolLoopProvider(),
    toolRegistry: registry,
    toolCallExecutor: new ToolCallExecutor({ registry }),
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: 2,
    debug: true,
  });

  const response = await gateway.handle(
    createGatewayRequest("请帮我确认 alpha project 的记忆", {
      sessionId: "session-auto-tool",
    })
  );

  assert.equal(response.text, "final answer based on tool results");
  assert.equal(response.toolCalls?.length, 1);
  assert.equal(response.toolCalls?.[0]?.toolName, "memory.search");
  assert.equal(response.memoryUsed.length, 1);
  assert.equal(response.memoryUsed[0]?.id, "mem-alpha-1");
  assert.equal(response.debug?.autoToolLoop?.attempted, true);
  assert.equal(response.debug?.autoToolLoop?.toolCallCount, 1);
});

test("Gateway falls back to normal answering when planner output is invalid", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "memory.search",
    description: "Search memory",
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
    },
    async invoke() {
      throw new Error("should not be called");
    },
  });

  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: new InvalidPlannerProvider(),
    toolRegistry: registry,
    toolCallExecutor: new ToolCallExecutor({ registry }),
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: 2,
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest("planner invalid test"));

  assert.equal(response.text, "fallback answer without auto tool loop");
  assert.equal(response.toolCalls?.length ?? 0, 0);
  assert.equal(response.debug?.autoToolLoop?.attempted, true);
  assert.equal(response.debug?.autoToolLoop?.finishReason, "planner-parse-failed");
  assert.match(response.debug?.autoToolLoop?.plannerError ?? "", /valid JSON/);
});

test("Gateway preserves memory selection explainability for auto tool memory results", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "memory.search",
    description: "Search memory",
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
    },
    async invoke() {
      return {
        ok: true,
        content: [
          {
            id: "workspace/memory/2026-05-01.md#Daily Notes",
            content: "Recent daily memory for alpha project",
            source: "workspace/memory/2026-05-01.md",
            metadata: {
              filePath: "workspace/memory/2026-05-01.md",
              date: "2026-05-01",
              sourceKind: "hybrid",
            },
          },
        ],
      };
    },
  });

  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: new ScriptedToolLoopProvider(),
    toolRegistry: registry,
    toolCallExecutor: new ToolCallExecutor({ registry }),
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: 2,
    debug: true,
  });

  const response = await gateway.handle(
    createGatewayRequest("please inspect recent alpha project memory")
  );

  assert.equal(response.memoryUsed.length, 1);
  assert.equal(response.debug?.memorySelection?.hasRecentMemory, true);
  assert.deepEqual(response.debug?.memorySelection?.sourceBreakdown, {
    hybrid: 1,
  });
  assert.deepEqual(response.debug?.memorySelection?.topMemoryIds, [
    "workspace/memory/2026-05-01.md#Daily Notes",
  ]);
});

test("Gateway directly executes explicit shell requests through bash.run", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "bash.run",
    description: "Run a shell command through the configured sandbox backend.",
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
    },
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
    async invoke() {
      return {
        ok: false,
        error: "must execute through ToolCallExecutor",
      };
    },
  });

  const captured: GatewayToolCallRequest[] = [];
  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: {
      name: "should-not-be-called",
      async generate() {
        throw new Error("model should not be called for direct shell requests");
      },
    },
    toolRegistry: registry,
    toolCallExecutor: {
      async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
        captured.push(request);
        return {
          id: request.id,
          toolName: request.toolName,
          input: request.input,
          status: "succeeded",
          createdAt: request.createdAt,
          durationMs: 12,
          output: {
            ok: true,
            content: {
              decision: "sandbox",
              stdout: "v20.20.2\n",
              stderr: "",
              exitCode: 0,
              artifacts: [],
            },
            metadata: {
              durationMs: 12,
            },
          },
        };
      },
    } as unknown as ToolCallExecutor,
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: 2,
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest("帮我运行 node -v"));

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.toolName, "bash.run");
  assert.deepEqual(captured[0]?.input, {
    command: "node -v",
  });
  assert.match(response.text, /v20\.20\.2/);
  assert.equal(response.toolCalls?.length, 1);
  assert.equal(response.debug?.autoToolLoop?.finishReason, "direct-shell-tool");
});
