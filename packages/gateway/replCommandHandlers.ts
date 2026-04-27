import type { Interface as ReadlineInterface } from "node:readline";

import { resolveWorkspacePath } from "../core/src/config";
import type { TranscriptEntry } from "../core/src/types";

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
import { SessionManager } from "./sessionManager";
import { GatewayMcpManager } from "./mcpManager";
import { createGatewayToolCallRequest } from "./toolCallFactory";
import { ToolCallExecutor } from "./toolCallExecutor";
import { printToolCallRecord } from "./toolCallPrinter";
import { ToolRegistry } from "./toolRegistry";
import { recordTranscript } from "./transcriptRecorder";

export interface ReplCommandHandlerContext {
  sessionManager: SessionManager;
  toolRegistry: ToolRegistry;
  toolCallExecutor: ToolCallExecutor;
  memoryTopK: number;
  mcpManager?: GatewayMcpManager;
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
  const recordToCurrentSession = (
    role: TranscriptEntry["role"],
    content: string
  ): void => {
    const sessionId = context.sessionManager.getCurrentSessionId();
    recordTranscript(sessionId, role, content);
    context.sessionManager.incrementCurrentSessionMessageCount();
  };

  if (command.type === "exit") {
    console.log("Bye.");
    recordToCurrentSession("assistant", "Bye.");
    context.rl.close();

    return {
      handled: true,
      shouldExit: true,
    };
  }

  if (command.type === "help") {
    printGatewayHelp();
    recordToCurrentSession("assistant", "Displayed help menu.");

    return {
      handled: true,
    };
  }

  if (command.type === "mcp") {
    const manager = context.mcpManager;
    const payload = (command.payload ?? "").trim();

    if (!manager || !manager.hasConfiguredServers()) {
      const output = "No MCP servers configured. Create config/mcp.servers.json.";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (!payload || payload === "status") {
      const statuses = manager.listStatuses();
      console.log("[mcp] server status:");
      statuses.forEach((status, index) => {
        const base = `${index + 1}. ${status.id} (${status.name}) enabled=${status.enabled} connected=${status.connected} tools=${status.toolCount}`;
        if (status.error) {
          console.log(`${base} error=${status.error}`);
        } else {
          console.log(base);
        }
      });
      recordToCurrentSession("assistant", `[mcp] listed ${statuses.length} server status(es).`);
      return {
        handled: true,
      };
    }

    if (payload === "tools") {
      const tools = manager.listTools();
      if (tools.length === 0) {
        const output = "[mcp] no MCP tools discovered";
        console.log(output);
        recordToCurrentSession("assistant", output);
        return {
          handled: true,
        };
      }

      console.log("[mcp] discovered tools:");
      tools.forEach((tool, index) => {
        const description = tool.description ?? "(no description)";
        console.log(
          `${index + 1}. ${tool.gatewayToolName} <- ${tool.serverId}.${tool.originalName} - ${description}`
        );
      });
      recordToCurrentSession("assistant", `[mcp] listed ${tools.length} tool(s).`);
      return {
        handled: true,
      };
    }

    const output = "[mcp] usage: :mcp | :mcp status | :mcp tools";
    console.log(output);
    recordToCurrentSession("assistant", output);
    return {
      handled: true,
    };
  }

  if (command.type === "tools") {
    const tools = context.toolRegistry.list();
    if (tools.length === 0) {
      const output = "[tools] no registered tools";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    console.log("[tools] registered:");
    tools.forEach((tool, index) => {
      console.log(`${index + 1}. ${tool.name} - ${tool.description}`);
    });
    recordToCurrentSession("assistant", `[tools] listed ${tools.length} tool(s).`);
    return {
      handled: true,
    };
  }

  if (command.type === "tool") {
    const payload = (command.payload ?? "").trim();
    if (!payload) {
      const output = "[tool] usage: :tool <name> <json>";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    const firstSpace = payload.indexOf(" ");
    const toolName = firstSpace === -1 ? payload : payload.slice(0, firstSpace).trim();
    const jsonInput = firstSpace === -1 ? "" : payload.slice(firstSpace + 1).trim();

    if (!toolName) {
      const output = "[tool] missing tool name. usage: :tool <name> <json>";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (!jsonInput) {
      const output = "[tool] missing json input. usage: :tool <name> <json>";
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    let parsedInput: Record<string, unknown>;
    try {
      const parsed = JSON.parse(jsonInput) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        const output = "[tool] json input must be an object";
        console.log(output);
        recordToCurrentSession("assistant", output);
        return {
          handled: true,
        };
      }
      parsedInput = parsed as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const output = `[tool] JSON parse failed: ${message}`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    const toolCallRequest = createGatewayToolCallRequest({
      toolName,
      input: parsedInput,
      sessionId: context.sessionManager.getCurrentSessionId(),
    });
    const toolCallRecord = await context.toolCallExecutor.execute(toolCallRequest);
    printToolCallRecord(toolCallRecord);
    recordToCurrentSession(
      "assistant",
      `[tool-call] ${toolCallRecord.toolName} ${toolCallRecord.status} (${toolCallRecord.id})`
    );
    return {
      handled: true,
    };
  }

  if (command.type === "session") {
    const payload = (command.payload ?? "").trim();

    if (!payload || payload === "current") {
      const current = context.sessionManager.getCurrentSession();
      const output = `[session] current: ${current.id} (${current.name}) messages=${current.messageCount}`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (payload === "list") {
      const currentId = context.sessionManager.getCurrentSessionId();
      const sessions = context.sessionManager.listSessions();

      console.log("[session] list");
      sessions.forEach((session) => {
        const currentFlag = session.id === currentId ? "*" : " ";
        console.log(
          `${currentFlag} ${session.id} | ${session.name} | messages=${session.messageCount}`
        );
      });

      recordToCurrentSession(
        "assistant",
        `[session] listed ${sessions.length} session(s).`
      );
      return {
        handled: true,
      };
    }

    if (payload.startsWith("new")) {
      const name = payload.replace(/^new\s*/, "").trim() || undefined;
      const created = context.sessionManager.createSession(name);
      const output = `[session] switched to new session: ${created.id} (${created.name})`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (payload === "switch" || payload.startsWith("switch ")) {
      const targetId = payload.replace(/^switch\s*/, "").trim();

      if (!targetId) {
        const output = "[session] missing sessionId. usage: :session switch <sessionId>";
        console.log(output);
        recordToCurrentSession("assistant", output);
        return {
          handled: true,
        };
      }

      const switched = context.sessionManager.switchSession(targetId);
      if (!switched) {
        const output = `[session] not found: ${targetId}`;
        console.log(output);
        recordToCurrentSession("assistant", output);
        return {
          handled: true,
        };
      }

      const output = `[session] switched: ${switched.id} (${switched.name})`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    if (payload === "rename" || payload.startsWith("rename ")) {
      const name = payload.replace(/^rename\s*/, "").trim();

      if (!name) {
        const output = "[session] missing name. usage: :session rename <name>";
        console.log(output);
        recordToCurrentSession("assistant", output);
        return {
          handled: true,
        };
      }

      const renamed = context.sessionManager.renameCurrentSession(name);
      const output = `[session] renamed: ${renamed.id} (${renamed.name})`;
      console.log(output);
      recordToCurrentSession("assistant", output);
      return {
        handled: true,
      };
    }

    const fallback =
      "[session] unknown subcommand. usage: :session | :session current | :session list | :session new [name] | :session switch <sessionId> | :session rename <name>";
    console.log(fallback);
    recordToCurrentSession("assistant", fallback);

    return {
      handled: true,
    };
  }

  if (command.type === "flush") {
    const res = preCompactionFlush(context.sessionManager.getCurrentSessionId());
    upsertFileIndex(resolveWorkspacePath("MEMORY.md"));

    console.log("[pre-compaction flush]", res);

    recordToCurrentSession("tool", `[pre-compaction flush] ${res.message}`);

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

    recordToCurrentSession(
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

      recordToCurrentSession("assistant", "[memory] empty content, skipped.");

      return {
        handled: true,
      };
    }

    const kind = classifyMemory(text);

    if (kind === "long-term") {
      writeLongTermMemory(text);
      upsertFileIndex(resolveWorkspacePath("MEMORY.md"));

      console.log("[saved] MEMORY.md");

      recordToCurrentSession("assistant", "[saved] MEMORY.md");

      return {
        handled: true,
      };
    }

    writeDailyMemory(text);

    // 保留你原来 main.ts 里的索引路径写法，避免这一步改变旧逻辑。
    upsertFileIndex(resolveWorkspacePath("memory", "2026-04-20.md"));

    console.log("[saved] daily memory");

    recordToCurrentSession("assistant", "[saved] daily memory");

    return {
      handled: true,
    };
  }

  if (command.type === "search-memory") {
    const query = command.payload ?? "";

    if (!query) {
      console.log("[search] empty query");

      recordToCurrentSession("assistant", "[search] empty query");

      return {
        handled: true,
      };
    }

    const hits = await hybridSearch(query, context.memoryTopK);

    if (hits.length === 0) {
      console.log("[search] no hits");

      recordToCurrentSession("assistant", "[search] no hits");

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

    recordToCurrentSession("assistant", `[search results]\n${summary}`);

    return {
      handled: true,
    };
  }

  if (command.type === "read-file") {
    const file = command.payload ?? "";

    if (!file) {
      console.log("[file] empty path");

      recordToCurrentSession("assistant", "[file] empty path");

      return {
        handled: true,
      };
    }

    try {
      const result = memoryGet(file);

      console.log("\n[file content]");
      console.log(result.text);

      recordToCurrentSession("assistant", `[file content]\n${result.text}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      console.error(message);

      recordToCurrentSession("assistant", `[error] ${message}`);
    }

    return {
      handled: true,
    };
  }

  return {
    handled: false,
  };
}
