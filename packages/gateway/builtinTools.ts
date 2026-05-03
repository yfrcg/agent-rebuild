import type { MemorySearch } from "./gateway";
import { createGatewayMemorySearch } from "./memoryAdapter";
import { createToolSecurityProfile } from "../sandbox/src/policy";
import { createSandboxedBashTool } from "./tools/sandboxedBash";
import { createSandboxedFileTools } from "./tools/sandboxedFile";
import { ToolRegistry } from "./toolRegistry";
import type { GatewayToolInput, GatewayToolPolicy } from "./toolTypes";
import type { MemorySearchResult } from "./types";

/**
 * 创建内建工具注册表时可传入的配置项。
 *
 * 调用方既可以传入已经初始化好的记忆检索函数，
 * 也可以只给 `topK`，让这里按默认方式创建检索能力。
 */
export interface BuiltinToolRegistryOptions {
  memorySearch?: MemorySearch;
  memoryTopK?: number;
  projectRoot?: string;
}

/**
 * 创建 Gateway 自带的工具注册表。
 *
 * 当前主要注册 `memory.search` 工具。它的目标是把“记忆搜索”包装成统一工具协议，
 * 这样无论调用方是命令行、Agent 还是未来的 MCP 映射层，都能走同一条执行路径。
 */
export function createBuiltinToolRegistry(
  options: BuiltinToolRegistryOptions = {}
): ToolRegistry {
  const registry = new ToolRegistry();
  const defaultTopK = options.memoryTopK ?? 5;
  const projectRoot = options.projectRoot ?? process.cwd();
  const memorySearchPolicy: GatewayToolPolicy = {
    automationLevel: "auto",
    riskLevel: "read-only",
    tags: ["memory", "search", "local"],
  };

  registry.register({
    name: "memory.search",
    description: "Search indexed memory by query text.",
    policy: memorySearchPolicy,
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: false,
      allowNetwork: false,
      allowWrite: false,
      allowHostExecution: true,
      requireApproval: false,
    }),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query text",
        },
        topK: {
          type: "number",
          description: "Optional top K result count",
        },
      },
      required: ["query"],
    },

    /**
     * 执行内建记忆搜索工具。
     *
     * 这里会先校验输入是否合法，再决定最终的 `topK`，
     * 最后调用记忆检索函数并把结果包装成统一的工具输出格式。
     */
    async invoke(input: GatewayToolInput) {
      const query = input.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        return {
          ok: false,
          error: "input.query required",
        };
      }

      const topKInput = input.topK;
      if (
        topKInput !== undefined &&
        (typeof topKInput !== "number" || !Number.isFinite(topKInput))
      ) {
        return {
          ok: false,
          error: "input.topK must be number",
        };
      }

      const resolvedTopK =
        typeof topKInput === "number" ? Math.max(1, Math.floor(topKInput)) : defaultTopK;

      const search = options.memorySearch ?? createGatewayMemorySearch(resolvedTopK);
      const results = (await search(query.trim())) as MemorySearchResult[];

      return {
        ok: true,
        content: results,
        metadata: {
          count: results.length,
        },
      };
    },
  });

  const bashTool = createSandboxedBashTool(projectRoot);
  registry.register(bashTool);
  registry.register({
    ...bashTool,
    name: "sandbox.exec",
    description: "Compatibility alias for bash.run.",
  });

  for (const tool of createSandboxedFileTools(projectRoot)) {
    registry.register(tool);
  }

  return registry;
}
