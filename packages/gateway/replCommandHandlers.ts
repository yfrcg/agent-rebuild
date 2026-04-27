import type { Interface as ReadlineInterface } from "node:readline";

import { resolveWorkspacePath } from "../core/src/config";

import {
  preCompactionFlush,
  postCompactionRecovery,
} from "../session/src/compaction";

import { classifyMemory } from "../memory/src/classifyMemory";
import {
  writeDailyMemory,
  writeLongTermMemory,
} from "../memory/src/memoryWriter";
import { memoryGet } from "../memory/src/memoryGet";
import { hybridSearch } from "../memory/src/hybridSearch";
import { upsertFileIndex } from "../memory/src/memoryIndex";

import type { ParsedGatewayCommand } from "./commandParser";
import { printGatewayHelp } from "./replHelp";
import { recordTranscript } from "./transcriptRecorder";

export interface ReplCommandHandlerContext {
  sessionId: string;
  memoryTopK: number;
  rl: ReadlineInterface;
}

export interface ReplCommandHandleResult {
  handled: boolean;
  shouldExit?: boolean;
}

export async function handleBuiltInGatewayCommand(
  command: ParsedGatewayCommand,
  context: ReplCommandHandlerContext
): Promise<ReplCommandHandleResult> {
  if (command.type === "exit") {
    console.log("Bye.");
    recordTranscript(context.sessionId, "assistant", "Bye.");
    context.rl.close();

    return {
      handled: true,
      shouldExit: true,
    };
  }

  if (command.type === "help") {
    printGatewayHelp();
    recordTranscript(
      context.sessionId,
      "assistant",
      "Displayed help menu."
    );

    return {
      handled: true,
    };
  }

  if (command.type === "flush") {
    const res = preCompactionFlush(context.sessionId);
    upsertFileIndex(resolveWorkspacePath("MEMORY.md"));

    console.log("[pre-compaction flush]", res);

    recordTranscript(
      context.sessionId,
      "tool",
      `[pre-compaction flush] ${res.message}`
    );

    return {
      handled: true,
    };
  }

  if (command.type === "recover") {
    const ctx = postCompactionRecovery();

    console.log("[post-compaction recovery]");
    for (const file of ctx.bootstrapFiles) {
      console.log(`- ${file.name}: ${file.missing ? "missing" : "ok"}`);
    }

    recordTranscript(
      context.sessionId,
      "tool",
      "[post-compaction recovery] restored from flush."
    );

    return {
      handled: true,
    };
  }

  if (command.type === "remember") {
    const text = command.payload ?? "";

    if (!text) {
      console.log("[memory] empty content, skipped.");

      recordTranscript(
        context.sessionId,
        "assistant",
        "[memory] empty content, skipped."
      );

      return {
        handled: true,
      };
    }

    const kind = classifyMemory(text);

    if (kind === "long-term") {
      writeLongTermMemory(text);
      upsertFileIndex(resolveWorkspacePath("MEMORY.md"));

      console.log("[saved] MEMORY.md");

      recordTranscript(
        context.sessionId,
        "assistant",
        "[saved] MEMORY.md"
      );

      return {
        handled: true,
      };
    }

    writeDailyMemory(text);

    // 保留你原来 main.ts 里的索引路径写法，避免这一步改变旧逻辑。
    upsertFileIndex(resolveWorkspacePath("memory", "2026-04-20.md"));

    console.log("[saved] daily memory");

    recordTranscript(
      context.sessionId,
      "assistant",
      "[saved] daily memory"
    );

    return {
      handled: true,
    };
  }

  if (command.type === "search-memory") {
    const query = command.payload ?? "";

    if (!query) {
      console.log("[search] empty query");

      recordTranscript(
        context.sessionId,
        "assistant",
        "[search] empty query"
      );

      return {
        handled: true,
      };
    }

    const hits = await hybridSearch(query, context.memoryTopK);

    if (hits.length === 0) {
      console.log("[search] no hits");

      recordTranscript(
        context.sessionId,
        "assistant",
        "[search] no hits"
      );

      return {
        handled: true,
      };
    }

    console.log("[search results]");
    hits.forEach((hit, idx) => {
      console.log(`\n#${idx + 1}`);
      console.log(`file: ${hit.filePath}`);
      console.log(`section: ${hit.section}`);
      console.log(hit.content.slice(0, 200));
    });

    const summary = hits
      .map((h, i) => `#${i + 1}: ${h.content.slice(0, 80)}`)
      .join("\n");

    recordTranscript(
      context.sessionId,
      "assistant",
      `[search results]\n${summary}`
    );

    return {
      handled: true,
    };
  }

  if (command.type === "read-file") {
    const file = command.payload ?? "";

    if (!file) {
      console.log("[file] empty path");

      recordTranscript(
        context.sessionId,
        "assistant",
        "[file] empty path"
      );

      return {
        handled: true,
      };
    }

    try {
      const result = memoryGet(file);

      console.log("\n[file content]");
      console.log(result.text);

      recordTranscript(
        context.sessionId,
        "assistant",
        `[file content]\n${result.text}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      console.error(message);

      recordTranscript(
        context.sessionId,
        "assistant",
        `[error] ${message}`
      );
    }

    return {
      handled: true,
    };
  }

  return {
    handled: false,
  };
}