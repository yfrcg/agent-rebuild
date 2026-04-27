import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { GatewayToolOutput } from "./toolTypes";
import type {
  GatewayMcpServerConfig,
  GatewayMcpServerStatus,
  GatewayMcpToolInfo,
} from "./mcpTypes";

const GATEWAY_CLIENT_INFO = {
  name: "agent-rebuild-gateway",
  version: "0.5.0",
};

export class GatewayMcpClient {
  private readonly config: GatewayMcpServerConfig;
  private client?: Client;
  private transport?: StdioClientTransport;
  private status: GatewayMcpServerStatus;
  private toolsCache: GatewayMcpToolInfo[] = [];

  constructor(config: GatewayMcpServerConfig) {
    this.config = config;
    this.status = {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      connected: false,
      toolCount: 0,
    };
  }

  async connect(): Promise<void> {
    if (this.status.connected) {
      return;
    }

    this.status.error = undefined;

    try {
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        cwd: this.config.cwd,
        env: mergeEnv(this.config.env),
      });
      this.client = new Client(GATEWAY_CLIENT_INFO, {
        capabilities: {},
      });
      await this.client.connect(this.transport);
      this.status.connected = true;
    } catch (err) {
      this.status.connected = false;
      this.status.error = toErrorMessage(err);
      throw new Error(
        `[mcp] failed to connect server "${this.config.id}" (${this.config.name}): ${this.status.error}`
      );
    }
  }

  async listTools(): Promise<GatewayMcpToolInfo[]> {
    if (this.toolsCache.length > 0) {
      return [...this.toolsCache];
    }

    if (!this.client || !this.status.connected) {
      throw new Error(
        `[mcp] server "${this.config.id}" is not connected, cannot list tools`
      );
    }

    const response = await this.client.listTools();
    const toolNamePrefix = this.config.toolNamePrefix ?? `mcp.${this.config.id}`;

    this.toolsCache = response.tools.map((tool) => ({
      serverId: this.config.id,
      serverName: this.config.name,
      originalName: tool.name,
      gatewayToolName: `${toolNamePrefix}.${tool.name}`,
      description: tool.description,
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as Record<string, unknown>)
          : undefined,
    }));

    this.status.toolCount = this.toolsCache.length;
    return [...this.toolsCache];
  }

  async callTool(
    originalName: string,
    input: Record<string, unknown>
  ): Promise<GatewayToolOutput> {
    if (!this.client || !this.status.connected) {
      return {
        ok: false,
        error: `[mcp] server "${this.config.id}" is not connected`,
        metadata: {
          serverId: this.config.id,
          originalToolName: originalName,
        },
      };
    }

    try {
      const result = await this.client.callTool({
        name: originalName,
        arguments: input,
      });

      if ("isError" in result && result.isError) {
        return {
          ok: false,
          error: extractToolError(result),
          content:
            "structuredContent" in result && result.structuredContent !== undefined
              ? result.structuredContent
              : "content" in result
                ? result.content
                : undefined,
          metadata: {
            serverId: this.config.id,
            originalToolName: originalName,
          },
        };
      }

      const content =
        "structuredContent" in result && result.structuredContent !== undefined
          ? result.structuredContent
          : "content" in result
            ? result.content
            : "toolResult" in result
              ? result.toolResult
              : undefined;

      return {
        ok: true,
        content,
        metadata: {
          serverId: this.config.id,
          originalToolName: originalName,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: `[mcp] callTool failed: ${toErrorMessage(err)}`,
        metadata: {
          serverId: this.config.id,
          originalToolName: originalName,
        },
      };
    }
  }

  async close(): Promise<void> {
    this.toolsCache = [];
    this.status.toolCount = 0;
    this.status.connected = false;

    try {
      await this.client?.close();
    } catch {
      // Ignore close errors to keep shutdown resilient.
    }

    try {
      await this.transport?.close();
    } catch {
      // Ignore close errors to keep shutdown resilient.
    }

    this.client = undefined;
    this.transport = undefined;
  }

  getStatus(): GatewayMcpServerStatus {
    return { ...this.status };
  }
}

function mergeEnv(override?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      base[key] = value;
    }
  }

  return {
    ...base,
    ...(override ?? {}),
  };
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractToolError(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "MCP tool returned error";
  }

  const response = result as { content?: unknown };
  if (Array.isArray(response.content)) {
    const textBlocks = response.content
      .filter(
        (item): item is { type: string; text: string } =>
          !!item &&
          typeof item === "object" &&
          "type" in item &&
          (item as { type?: unknown }).type === "text" &&
          "text" in item &&
          typeof (item as { text?: unknown }).text === "string"
      )
      .map((item) => item.text.trim())
      .filter(Boolean);

    if (textBlocks.length > 0) {
      return textBlocks.join(" | ");
    }
  }

  return "MCP tool returned isError=true";
}
