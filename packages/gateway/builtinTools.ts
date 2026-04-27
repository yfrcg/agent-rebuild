import type { MemorySearch } from "./gateway";
import { createGatewayMemorySearch } from "./memoryAdapter";
import { ToolRegistry } from "./toolRegistry";
import type { GatewayToolInput } from "./toolTypes";
import type { MemorySearchResult } from "./types";

export interface BuiltinToolRegistryOptions {
  memorySearch?: MemorySearch;
  memoryTopK?: number;
}

export function createBuiltinToolRegistry(
  options: BuiltinToolRegistryOptions = {}
): ToolRegistry {
  const registry = new ToolRegistry();
  const defaultTopK = options.memoryTopK ?? 5;

  registry.register({
    name: "memory.search",
    description: "Search indexed memory by query text.",
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

  return registry;
}
