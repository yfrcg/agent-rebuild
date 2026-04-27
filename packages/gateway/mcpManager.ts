import { createGatewayToolsFromMcpClient } from "./mcpToolAdapter";
import { GatewayMcpClient } from "./mcpClient";
import type {
  GatewayMcpServerConfig,
  GatewayMcpServerStatus,
  GatewayMcpToolInfo,
} from "./mcpTypes";
import type { ToolRegistry } from "./toolRegistry";

export class GatewayMcpManager {
  private readonly configs: GatewayMcpServerConfig[];
  private readonly clients = new Map<string, GatewayMcpClient>();
  private readonly statuses = new Map<string, GatewayMcpServerStatus>();
  private readonly tools = new Map<string, GatewayMcpToolInfo[]>();

  constructor(configs: GatewayMcpServerConfig[]) {
    this.configs = configs;

    for (const config of this.configs) {
      this.statuses.set(config.id, {
        id: config.id,
        name: config.name,
        enabled: config.enabled,
        connected: false,
        toolCount: 0,
      });
    }
  }

  hasConfiguredServers(): boolean {
    return this.configs.length > 0;
  }

  async connectEnabledServers(): Promise<void> {
    for (const config of this.configs) {
      if (!config.enabled) {
        this.statuses.set(config.id, {
          id: config.id,
          name: config.name,
          enabled: false,
          connected: false,
          toolCount: 0,
        });
        continue;
      }

      const client = new GatewayMcpClient(config);
      this.clients.set(config.id, client);

      try {
        await client.connect();
        this.statuses.set(config.id, client.getStatus());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = client.getStatus();
        this.statuses.set(config.id, {
          ...status,
          connected: false,
          error: message,
        });
      }
    }
  }

  async registerTools(registry: ToolRegistry): Promise<void> {
    for (const [serverId, client] of this.clients.entries()) {
      const currentStatus = client.getStatus();
      if (!currentStatus.connected) {
        this.statuses.set(serverId, currentStatus);
        continue;
      }

      try {
        const discoveredTools = await client.listTools();
        this.tools.set(serverId, discoveredTools);

        const gatewayTools = await createGatewayToolsFromMcpClient(client);
        let registeredCount = 0;

        for (const tool of gatewayTools) {
          try {
            registry.register(tool);
            registeredCount += 1;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const status = client.getStatus();
            this.statuses.set(serverId, {
              ...status,
              error: `[mcp] tool registration error: ${message}`,
            });
          }
        }

        const status = client.getStatus();
        this.statuses.set(serverId, {
          ...status,
          toolCount: registeredCount,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = client.getStatus();
        this.statuses.set(serverId, {
          ...status,
          error: `[mcp] failed to discover/register tools: ${message}`,
        });
      }
    }
  }

  listStatuses(): GatewayMcpServerStatus[] {
    return this.configs.map((config) => {
      const status = this.statuses.get(config.id);
      if (!status) {
        return {
          id: config.id,
          name: config.name,
          enabled: config.enabled,
          connected: false,
          toolCount: 0,
        };
      }
      return { ...status };
    });
  }

  listTools(): GatewayMcpToolInfo[] {
    const allTools: GatewayMcpToolInfo[] = [];
    for (const tools of this.tools.values()) {
      allTools.push(...tools);
    }
    return allTools;
  }

  async close(): Promise<void> {
    const closeTasks = Array.from(this.clients.values()).map(async (client) => {
      try {
        await client.close();
      } catch {
        // Ignore close errors to keep shutdown resilient.
      }
    });

    await Promise.all(closeTasks);
    this.clients.clear();
  }
}
