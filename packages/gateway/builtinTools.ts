import {
  classifyMemory,
  classifyMemoryType,
} from "../memory/src/classifyMemory";
import {
  writeDailyMemory,
  writeLongTermMemory,
} from "../memory/src/memoryWriter";
import { resolveProjectRoot } from "../core/src/config";
import { createToolSecurityProfile } from "../sandbox/src/policy";
import { createGatewayMemorySearch } from "./memoryAdapter";
import type { MemorySearch } from "./gateway";
import { ToolRegistry } from "./toolRegistry";
import {
  createSandboxedBashTool,
  createSandboxedBuildTool,
  createSandboxedNpmTestTool,
  createSandboxedRunTestTool,
} from "./tools/sandboxedBash";
import { createSandboxedFileTools } from "./tools/sandboxedFile";
import type {
  GatewayTool,
  GatewayToolContext,
  GatewayToolInput,
  GatewayToolPolicy,
  ToolResult,
} from "./toolTypes";
import type { MemorySearchResult } from "./types";

export interface BuiltinToolRegistryOptions {
  memorySearch?: MemorySearch;
  memoryTopK?: number;
  projectRoot?: string;
}

export function createBuiltinToolRegistry(
  options: BuiltinToolRegistryOptions = {}
): ToolRegistry {
  const registry = new ToolRegistry();
  const defaultTopK = options.memoryTopK ?? 5;
  const projectRoot = options.projectRoot ?? resolveProjectRoot();

  registry.register(createMemorySearchTool(options.memorySearch, defaultTopK));
  registry.register(createMemoryWriteTool());

  const shellTool = createSandboxedBashTool(projectRoot, "shell.run");
  registry.register(shellTool);
  registry.register({
    ...shellTool,
    name: "bash.run",
    description: "Compatibility alias for shell.run.",
  });
  registry.register({
    ...shellTool,
    name: "sandbox.exec",
    description: "Compatibility alias for shell.run.",
  });
  registry.register(createSandboxedRunTestTool(projectRoot));
  registry.register(createSandboxedNpmTestTool(projectRoot));
  registry.register(createSandboxedBuildTool(projectRoot));

  for (const tool of createSandboxedFileTools(projectRoot)) {
    registry.register(tool);
  }

  return registry;
}

function createMemorySearchTool(
  memorySearch: MemorySearch | undefined,
  defaultTopK: number
): GatewayTool {
  const policy: GatewayToolPolicy = {
    automationLevel: "auto",
    riskLevel: "read-only",
    tags: ["memory", "search", "local"],
  };

  const schema = {
    type: "object",
    properties: {
      query: {
        type: "string",
      },
      topK: {
        type: "number",
      },
    },
    required: ["query"],
  } satisfies Record<string, unknown>;

  const execute = async (
    args: unknown,
    context?: GatewayToolContext
  ): Promise<ToolResult> => {
    const input = asToolInput(args);
    const query = input.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      return failToolResult(context, "input.query required");
    }

    const topKInput = input.topK;
    if (
      topKInput !== undefined &&
      (typeof topKInput !== "number" || !Number.isFinite(topKInput))
    ) {
      return failToolResult(context, "input.topK must be number");
    }

    const resolvedTopK =
      typeof topKInput === "number" ? Math.max(1, Math.floor(topKInput)) : defaultTopK;

    const search = memorySearch ?? createGatewayMemorySearch(resolvedTopK);
    const results = (await search(query.trim())) as MemorySearchResult[];

    return {
      toolCallId: context?.requestId ?? "",
      ok: true,
      result: results,
    };
  };

  return {
    name: "memory.search",
    description: "Search indexed memory by query text.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy,
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowNetwork: false,
      allowWrite: false,
      allowHostExecution: true,
      requireApproval: false,
    }),
    execute,
    async invoke(input, context) {
      const result = await execute(input, context);
      return {
        ok: result.ok,
        content: result.result,
        error: result.error,
        metadata: {
          count: Array.isArray(result.result) ? result.result.length : undefined,
        },
      };
    },
  };
}

function createMemoryWriteTool(): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      content: {
        type: "string",
      },
      tags: {
        type: "array",
        items: {
          type: "string",
        },
      },
    },
    required: ["content"],
  } satisfies Record<string, unknown>;

  const execute = async (
    args: unknown,
    context?: GatewayToolContext
  ): Promise<ToolResult> => {
    const input = asToolInput(args);
    const content =
      typeof input.content === "string" ? input.content.trim() : "";
    if (!content) {
      return failToolResult(context, "input.content required");
    }

    const tags = Array.isArray(input.tags)
      ? input.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const preferLongTerm = tags.some((tag) => /long[-_\s]?term/i.test(tag));
    const kind = preferLongTerm ? "long-term" : classifyMemory(content);
    const category = classifyMemoryType(content);
    const filePath =
      kind === "long-term"
        ? writeLongTermMemory(content)
        : writeDailyMemory(content);

    return {
      toolCallId: context?.requestId ?? "",
      ok: true,
      result: {
        kind,
        category,
        path: filePath,
        tags,
      },
    };
  };

  return {
    name: "memory.write",
    description: "Write a memory note into daily or long-term local memory.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: ["memory", "write", "local"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: false,
      allowWrite: true,
      allowHostExecution: true,
      requireApproval: false,
    }),
    execute,
    async invoke(input, context) {
      const result = await execute(input, context);
      return {
        ok: result.ok,
        content: result.result,
        error: result.error,
      };
    },
  };
}

function asToolInput(args: unknown): GatewayToolInput {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }

  return args as GatewayToolInput;
}

function failToolResult(
  context: GatewayToolContext | undefined,
  error: string
): ToolResult {
  return {
    toolCallId: context?.requestId ?? "",
    ok: false,
    error,
  };
}
