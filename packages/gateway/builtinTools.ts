import type { MemorySearch } from "./gateway";
import { createGatewayMemorySearch } from "./memoryAdapter";
import { createToolSecurityProfile } from "../sandbox/src/policy";
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

  registry.register({
    name: "sandbox.exec",
    description: "Run a command inside an isolated Docker sandbox.",
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: ["sandbox", "exec", "docker"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: true,
      allowNetwork: false,
      allowWrite: true,
      allowHostExecution: false,
      requireApproval: false,
    }),
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to run inside the sandbox",
        },
        cwd: {
          type: "string",
          description: "Optional working directory relative to the project root",
        },
        timeoutMs: {
          type: "number",
          description: "Optional timeout in milliseconds",
        },
        image: {
          type: "string",
          description: "Optional container image override",
        },
        env: {
          type: "object",
          description: "Optional environment variables to expose inside the sandbox",
        },
        inputFiles: {
          type: "array",
          description: "Optional files to place into the copied workspace before execution",
        },
      },
      required: ["command"],
    },
    sandboxSpec: {
      resolve(input) {
        const command = input.command;
        if (typeof command !== "string" || command.trim().length === 0) {
          throw new Error("input.command required");
        }

        const env = normalizeEnvRecord(input.env);
        const inputFiles = normalizeInputFiles(input.inputFiles);

        return {
          command: "sh",
          args: ["-lc", command],
          cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
          timeoutMs:
            typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
              ? Math.max(1, Math.floor(input.timeoutMs))
              : undefined,
          image: typeof input.image === "string" && input.image.trim().length > 0
            ? input.image.trim()
            : undefined,
          env,
          inputFiles,
          network: "none",
          workspaceAccess: "copy",
        };
      },
    },
    async invoke() {
      return {
        ok: false,
        error: "sandbox.exec must run through the sandbox execution path",
      };
    },
  });

  return registry;
}

function normalizeEnvRecord(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const entries = Object.entries(input as Record<string, unknown>).filter(
    ([key, value]) => key.trim().length > 0 && typeof value === "string"
  );
  if (entries.length === 0) {
    return undefined;
  }

  return entries.reduce<Record<string, string>>((acc, [key, value]) => {
    acc[key] = value as string;
    return acc;
  }, {});
}

function normalizeInputFiles(
  input: unknown
): Array<{ path: string; content: string }> | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const normalized = input.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    return typeof candidate.path === "string" && typeof candidate.content === "string"
      ? [
          {
            path: candidate.path as string,
            content: candidate.content as string,
          },
        ]
      : [];
  });

  return normalized.length > 0 ? normalized : undefined;
}
