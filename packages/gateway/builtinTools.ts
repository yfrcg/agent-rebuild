
import {
  classifyMemory,
  classifyMemoryType,
} from "../memory/src/classifyMemory";
import {
  writeDailyMemory,
  writeLongTermMemory,
} from "../memory/src/memoryWriter";
import { resolveProjectRoot } from "../core/src/config";
import {
  discoverSkills,
  getSkillByName,
  resolveSkillPrompt,
  buildSkillDescriptions,
} from "../core/src/skills";
import type { SkillDefinition } from "../core/src/skills";
import { createToolSecurityProfile } from "./toolSecurityProfile";
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
import { createGitTools } from "./tools/gitTools";
import { createDevTools } from "./tools/devTools";
import { createWebFetchTool } from "./tools/webFetch";
import { createTodoTools } from "./tools/todoTools";
import { createAgentTools } from "./tools/agentTools";
import type {
  GatewayTool,
  GatewayToolContext,
  GatewayToolInput,
  GatewayToolPolicy,
  ToolResult,
} from "./toolTypes";
import type { MemorySearchResult, WebSearchInput } from "./types";
import { tavilySearch, validateSearchInput, clampMaxResults } from "./webSearchProvider";

export interface BuiltinToolRegistryOptions {
  memorySearch?: MemorySearch;
  memoryTopK?: number;
  projectRoot?: string;
  tavilyApiKey?: string;
}

/**
 * 函数 `createBuiltinToolRegistry` 的职责说明。
 * `createBuiltinToolRegistry` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
  registry.register(createSandboxedRunTestTool(projectRoot));
  registry.register(createSandboxedNpmTestTool(projectRoot));
  registry.register(createSandboxedBuildTool(projectRoot));

  for (const tool of createSandboxedFileTools(projectRoot)) {
    registry.register(tool);
  }

  registry.register(createSkillTool());

  registry.register(createWebSearchTool(options.tavilyApiKey ?? ""));

  for (const tool of createGitTools(projectRoot)) {
    registry.register(tool);
  }

  for (const tool of createDevTools(projectRoot)) {
    registry.register(tool);
  }

  for (const tool of createWebFetchTool()) {
    registry.register(tool);
  }

  for (const tool of createTodoTools(projectRoot)) {
    registry.register(tool);
  }

  for (const tool of createAgentTools(projectRoot)) {
    registry.register(tool);
  }

  return registry;
}

/**
 * 函数 `createMemorySearchTool` 的职责说明。
 * `createMemorySearchTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

  /** 函数变量 `execute`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
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
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
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

/**
 * 函数 `createMemoryWriteTool` 的职责说明。
 * `createMemoryWriteTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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

  /** 函数变量 `execute`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
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
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
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

/**
 * 函数 `createSkillTool` 的职责说明。
 * `createSkillTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createSkillTool(): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      skill_name: {
        type: "string",
        description: "The name of the skill to invoke",
      },
      args: {
        type: "string",
        description: "Optional arguments to pass to the skill template",
      },
    },
    required: ["skill_name"],
  } satisfies Record<string, unknown>;

  /** 函数变量 `execute`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
  const execute = async (
    args: unknown,
    context?: GatewayToolContext
  ): Promise<ToolResult> => {
    const input = asToolInput(args);
    const skillName =
      typeof input.skill_name === "string" ? input.skill_name.trim() : "";
    if (!skillName) {
      return failToolResult(context, "input.skill_name required");
    }

    const skillArgs =
      typeof input.args === "string" ? input.args : "";

    const allSkills = discoverSkills().skills;
    const skill = getSkillByName(skillName, allSkills);

    if (!skill) {
      const available = allSkills
        .filter((s) => s.userInvocable)
        .map((s) => s.name)
        .slice(0, 20);
      return failToolResult(
        context,
        `Skill "${skillName}" not found. Available: ${available.join(", ") || "(none)"}`
      );
    }

    const resolvedPrompt = resolveSkillPrompt(skill, skillArgs);

    return {
      toolCallId: context?.requestId ?? "",
      ok: true,
      result: {
        skill: skill.name,
        context: skill.context,
        allowedTools: skill.allowedTools,
        prompt: resolvedPrompt,
        source: skill.source,
        platform: skill.platform,
      },
    };
  };

  return {
    name: "skill",
    description:
      "Invoke a registered skill by name. Skills are prompt templates loaded from skill directories. Returns the skill's resolved prompt to follow.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["skill", "prompt", "local"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowNetwork: false,
      allowWrite: false,
      allowHostExecution: true,
      requireApproval: false,
    }),
    execute,
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
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

/**
 * 函数 `createWebSearchTool` 的职责说明。
 * `createWebSearchTool` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createWebSearchTool(tavilyApiKey: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query text (max 300 characters).",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return (1-10, default 5).",
      },
      topic: {
        type: "string",
        enum: ["general", "news", "finance"],
        description: "Search topic category. Default: general.",
      },
      includeDomains: {
        type: "array",
        items: { type: "string" },
        description: "Only include results from these domains.",
      },
      excludeDomains: {
        type: "array",
        items: { type: "string" },
        description: "Exclude results from these domains.",
      },
      freshness: {
        type: "string",
        enum: ["day", "week", "month", "year", "any"],
        description: "Filter results by freshness. Default: any.",
      },
    },
    required: ["query"],
  } satisfies Record<string, unknown>;

  /** 函数变量 `execute`：保存可调用逻辑，调用方依赖它完成对应流程或测试夹具行为。 */
  const execute = async (
    args: unknown,
    context?: GatewayToolContext
  ): Promise<ToolResult> => {
    const input = asToolInput(args);

    const searchInput: WebSearchInput = {
      query: typeof input.query === "string" ? input.query : "",
      maxResults: typeof input.maxResults === "number" ? input.maxResults : undefined,
      topic: typeof input.topic === "string" ? input.topic as WebSearchInput["topic"] : undefined,
      includeDomains: Array.isArray(input.includeDomains)
        ? input.includeDomains.filter((d): d is string => typeof d === "string")
        : undefined,
      excludeDomains: Array.isArray(input.excludeDomains)
        ? input.excludeDomains.filter((d): d is string => typeof d === "string")
        : undefined,
      freshness: typeof input.freshness === "string" ? input.freshness as WebSearchInput["freshness"] : undefined,
    };

    const validationError = validateSearchInput(searchInput);
    if (validationError) {
      return failToolResult(context, validationError);
    }

    searchInput.maxResults = clampMaxResults(searchInput.maxResults);

    try {
      const output = await tavilySearch(searchInput, { apiKey: tavilyApiKey });
      return {
        toolCallId: context?.requestId ?? "",
        ok: true,
        result: output,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown web search error";
      return failToolResult(context, message);
    }
  };

  return {
    name: "web.search",
    description: "Search the web for current information using Tavily API. Returns titles, URLs, snippets, and scores. Use for: current events, latest API docs, unfamiliar libraries/projects/papers, factual verification.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "external-read",
      tags: ["web", "search", "network", "tavily"],
    },
    security: createToolSecurityProfile({
      riskLevel: "low",
      sandboxRequired: false,
      allowNetwork: true,
      allowWrite: false,
      allowHostExecution: true,
      requireApproval: false,
    }),
    execute,
    /** 方法 `invoke`：封装当前类或接口的一步业务操作，调用方依赖它的输入输出契约和错误处理语义。 */
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

/**
 * 函数 `asToolInput` 的职责说明。
 * `asToolInput` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function asToolInput(args: unknown): GatewayToolInput {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }

  return args as GatewayToolInput;
}

/**
 * 函数 `failToolResult` 的职责说明。
 * `failToolResult` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
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
