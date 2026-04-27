import { hybridSearch } from "../memory/src/hybridSearch";
import type { MemorySearch } from "./gateway";
import type { MemorySearchResult } from "./types";

export function createGatewayMemorySearch(topK = 5): MemorySearch {
  return async function gatewayMemorySearch(
    query: string
  ): Promise<MemorySearchResult[]> {
    const hits = await hybridSearch(query, topK);

    return hits.map((hit, index) => {
      return {
        id: createMemoryResultId(hit.filePath, hit.section, index),
        content: hit.content,
        source: hit.filePath,
        metadata: {
          section: hit.section,
        },
      };
    });
  };
}

function createMemoryResultId(
  filePath: string,
  section: string | undefined,
  index: number
): string {
  return `${filePath}#${section ?? index + 1}`;
}