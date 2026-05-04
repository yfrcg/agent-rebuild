import assert from "node:assert/strict";
import test from "node:test";

import { Gateway } from "../packages/gateway/gateway";
import { resolveProjectRoot } from "../packages/core/src/config";
import { createGatewayRequest } from "../packages/gateway/requestHandler";
import { ToolCallExecutor } from "../packages/gateway/toolCallExecutor";
import { ToolRegistry } from "../packages/gateway/toolRegistry";
import type {
  GatewayToolCallRecord,
  GatewayToolCallRequest,
} from "../packages/gateway/toolCallTypes";
import type { ChatMessage, ModelProvider, ModelResponse } from "../packages/model/types";

class MemorySearchProtocolProvider implements ModelProvider {
  name = "memory-search-protocol";
  private step = 0;

  async generate(): Promise<ModelResponse> {
    this.step += 1;

    if (this.step === 1) {
      return {
        text: JSON.stringify({
          type: "tool_call",
          tool: "memory.search",
          args: {
            query: "alpha project",
            topK: 1,
          },
        }),
      };
    }

    return {
      text: JSON.stringify({
        type: "final",
        content: "final answer based on tool results",
      }),
    };
  }
}

class PlainTextProvider implements ModelProvider {
  name = "plain-text";

  async generate(): Promise<ModelResponse> {
    return {
      text: "plain text fallback answer",
    };
  }
}

class ToolBudgetProvider implements ModelProvider {
  name = "tool-budget";

  async generate(messages: ChatMessage[]): Promise<ModelResponse> {
    const forceFinal = messages.some(
      (message) =>
        message.role === "system" &&
        message.content.includes('Return only {"type":"final","content":"..."} now.')
    );

    if (forceFinal) {
      return {
        text: JSON.stringify({
          type: "final",
          content: "forced final answer after tool budget",
        }),
      };
    }

    return {
      text: JSON.stringify({
        type: "tool_call",
        tool: "memory.search",
        args: {
          query: "loop forever",
        },
      }),
    };
  }
}

test("Gateway agent loop executes memory.search and returns final JSON content", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "memory.search",
    description: "Search memory",
    schema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    riskLevel: "safe",
    async execute(input) {
      const args = input as Record<string, unknown>;
      assert.equal(args.query, "alpha project");
      return {
        toolCallId: "",
        ok: true,
        result: [
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
    modelProvider: new MemorySearchProtocolProvider(),
    toolRegistry: registry,
    toolCallExecutor: new ToolCallExecutor({ registry }),
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: 5,
    debug: true,
  });

  const response = await gateway.handle(
    createGatewayRequest("please confirm alpha project memory", {
      sessionId: "session-auto-tool",
    })
  );

  assert.equal(response.text, "final answer based on tool results");
  assert.equal(response.toolCalls?.length, 1);
  assert.equal(response.toolCalls?.[0]?.toolName, "memory.search");
  assert.equal(response.toolCalls?.[0]?.riskLevel, "safe");
  assert.equal(response.memoryUsed.length, 1);
  assert.equal(response.memoryUsed[0]?.id, "mem-alpha-1");
  assert.equal(response.debug?.autoToolLoop?.attempted, true);
  assert.equal(response.debug?.autoToolLoop?.toolCallCount, 1);
  assert.equal(response.debug?.autoToolLoop?.finishReason, "final");
});

test("Gateway falls back to plain text when model output is not JSON protocol", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "memory.search",
    description: "Search memory",
    riskLevel: "safe",
    async execute() {
      throw new Error("should not be called");
    },
  });

  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: new PlainTextProvider(),
    toolRegistry: registry,
    toolCallExecutor: new ToolCallExecutor({ registry }),
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: 5,
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest("planner invalid test"));

  assert.equal(response.text, "plain text fallback answer");
  assert.equal(response.toolCalls?.length ?? 0, 0);
  assert.equal(response.debug?.autoToolLoop?.attempted, true);
  assert.equal(response.debug?.autoToolLoop?.finishReason, "plain-text-fallback");
});

test("Gateway enforces a maximum of 5 tool calls before forcing final output", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "memory.search",
    description: "Search memory",
    schema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    riskLevel: "safe",
    async execute() {
      return {
        toolCallId: "",
        ok: true,
        result: [],
      };
    },
  });

  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: new ToolBudgetProvider(),
    toolRegistry: registry,
    toolCallExecutor: new ToolCallExecutor({ registry }),
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: 5,
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest("loop test"));

  assert.equal(response.text, "forced final answer after tool budget");
  assert.equal(response.toolCalls?.length, 5);
  assert.equal(response.debug?.autoToolLoop?.toolCallCount, 5);
  assert.equal(response.debug?.autoToolLoop?.finishReason, "tool-budget-exhausted");
});

test("Gateway can execute shell.run tool calls through ToolCallExecutor", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "shell.run",
    description: "Run a shell command through the configured sandbox backend.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
    riskLevel: "dangerous",
    async execute() {
      return {
        toolCallId: "",
        ok: false,
        error: "must execute through ToolCallExecutor",
      };
    },
  });

  const captured: GatewayToolCallRequest[] = [];
  let step = 0;
  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: {
      name: "shell-run-provider",
      async generate(_messages: ChatMessage[]) {
        step += 1;
        if (step === 1) {
          return {
            text: JSON.stringify({
              type: "tool_call",
              tool: "shell.run",
              args: {
                command: "node -v",
              },
            }),
          };
        }

        return {
          text: JSON.stringify({
            type: "final",
            content: "node version is v20.20.2",
          }),
        };
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
          status: "success",
          riskLevel: "dangerous",
          createdAt: request.createdAt,
          durationMs: 12,
          result: {
            toolCallId: request.id,
            ok: true,
            result: {
              stdout: "v20.20.2\n",
              stderr: "",
              exitCode: 0,
            },
            durationMs: 12,
          },
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
    autoToolLoopMaxSteps: 5,
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest("run node -v"));

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.toolName, "shell.run");
  assert.deepEqual(captured[0]?.input, {
    command: "node -v",
  });
  assert.equal(response.text, "node version is v20.20.2");
  assert.equal(response.toolCalls?.length, 1);
});

test("Gateway defaults shell.run cwd to the Windows project root when cwd is missing", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "shell.run",
    description: "Run a shell command through the configured sandbox backend.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
    riskLevel: "dangerous",
    async execute(input) {
      return {
        toolCallId: "",
        ok: true,
        result: input,
      };
    },
  });

  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: {
      name: "shell-cwd-default",
      async generate() {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "shell.run",
            args: {
              command: "node -v",
            },
          }),
        };
      },
    },
    toolRegistry: registry,
    toolCallExecutor: new ToolCallExecutor({ registry }),
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: 1,
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest("run node -v"));

  assert.equal(response.toolCalls?.length, 1);
  assert.deepEqual(response.toolCalls?.[0]?.input, {
    command: "node -v",
    cwd: resolveProjectRoot(),
  });
});

test("Gateway normalizes shell.run cwd from /workspace to the Windows project root", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "shell.run",
    description: "Run a shell command through the configured sandbox backend.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command"],
    },
    riskLevel: "dangerous",
    async execute(input) {
      return {
        toolCallId: "",
        ok: true,
        result: input,
      };
    },
  });

  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: {
      name: "shell-cwd-normalizer",
      async generate() {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "shell.run",
            args: {
              command: "node -v",
              cwd: "/workspace",
            },
          }),
        };
      },
    },
    toolRegistry: registry,
    toolCallExecutor: new ToolCallExecutor({ registry }),
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: 1,
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest("run node -v from workspace"));

  assert.equal(response.toolCalls?.length, 1);
  assert.deepEqual(response.toolCalls?.[0]?.input, {
    command: "node -v",
    cwd: resolveProjectRoot(),
  });
});

test("Gateway can execute file.read tool calls through ToolCallExecutor", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "file.read",
    description: "Read a text file",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    riskLevel: "safe",
    async execute() {
      return {
        toolCallId: "",
        ok: false,
        error: "must execute through ToolCallExecutor",
      };
    },
  });

  const captured: GatewayToolCallRequest[] = [];
  let step = 0;
  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: {
      name: "file-read-provider",
      async generate(_messages: ChatMessage[]) {
        step += 1;
        if (step === 1) {
          return {
            text: JSON.stringify({
              type: "tool_call",
              tool: "file.read",
              args: {
                path: "package.json",
              },
            }),
          };
        }

        return {
          text: JSON.stringify({
            type: "final",
            content: "package.json contains the project name agent-rebuild",
          }),
        };
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
          status: "success",
          riskLevel: "safe",
          createdAt: request.createdAt,
          durationMs: 8,
          result: {
            toolCallId: request.id,
            ok: true,
            result: '{ "name": "agent-rebuild" }',
            durationMs: 8,
          },
          output: {
            ok: true,
            content: '{ "name": "agent-rebuild" }',
            metadata: {
              durationMs: 8,
            },
          },
        };
      },
    } as unknown as ToolCallExecutor,
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: 5,
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest("read package.json"));

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.toolName, "file.read");
  assert.deepEqual(captured[0]?.input, {
    path: "package.json",
  });
  assert.equal(response.text, "package.json contains the project name agent-rebuild");
});

test("Gateway agent loop continues after an execution tool returns a structured failure", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "npm_test",
    description: "Run npm test in sandbox",
    permissionLevel: "execute",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: true,
    riskLevel: "dangerous",
    async execute() {
      return {
        toolCallId: "",
        ok: false,
        error: "must execute through ToolCallExecutor",
      };
    },
  });

  let step = 0;
  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: {
      name: "npm-test-failure-provider",
      async generate() {
        step += 1;
        if (step === 1) {
          return {
            text: JSON.stringify({
              type: "tool_call",
              tool: "npm_test",
              args: {},
            }),
          };
        }

        return {
          text: JSON.stringify({
            type: "final",
            content: "npm test failed with 2 failing specs",
          }),
        };
      },
    },
    toolRegistry: registry,
    toolCallExecutor: {
      async execute(request: GatewayToolCallRequest): Promise<GatewayToolCallRecord> {
        return {
          id: request.id,
          toolName: request.toolName,
          input: request.input,
          status: "error",
          riskLevel: "dangerous",
          permissionLevel: "execute",
          createdAt: request.createdAt,
          durationMs: 30,
          error: "sandbox command failed with exit code 2",
          result: {
            toolCallId: request.id,
            ok: false,
            result: {
              ok: false,
              exitCode: 2,
              stderrPreview: "2 failing specs",
              stdoutPreview: "running tests",
              durationMs: 30,
              timedOut: false,
            },
            error: "sandbox command failed with exit code 2",
            durationMs: 30,
          },
          output: {
            ok: false,
            content: {
              ok: false,
              exitCode: 2,
              stderrPreview: "2 failing specs",
              stdoutPreview: "running tests",
              durationMs: 30,
              timedOut: false,
            },
            error: "sandbox command failed with exit code 2",
            metadata: {
              exitCode: 2,
              durationMs: 30,
              timedOut: false,
            },
          },
        };
      },
    } as unknown as ToolCallExecutor,
    autoToolLoopEnabled: true,
    autoToolLoopMaxSteps: 5,
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest("run npm test and summarize failures"));

  assert.equal(response.text, "npm test failed with 2 failing specs");
  assert.equal(response.toolCalls?.length, 1);
  assert.equal(response.toolCalls?.[0]?.status, "error");
  assert.equal(response.debug?.autoToolLoop?.finishReason, "final");
});
