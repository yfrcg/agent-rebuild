/**
 * ?????CS336 ???
 * ???packages/gateway/mcpManager.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { createGatewayToolsFromMcpClient } from "./mcpToolAdapter";
import { GatewayMcpClient } from "./mcpClient";
import type { GatewaySandbox } from "./sandbox";
import type {
  GatewayMcpServerConfig,
  GatewayMcpServerStatus,
  GatewayMcpToolInfo,
} from "./mcpTypes";
import type { ToolRegistry } from "./toolRegistry";

/**
 * MCP 服务总管理器。
 *
 * 这个类站在更高一层，负责同时管理多台 MCP 服务：
 * - 维护每台服务的配置、状态与客户端实例
 * - 批量连接所有启用的服务
 * - 把远端工具注册进 Gateway 统一工具表
 */
export interface GatewayMcpManagerOptions {
  lazy?: boolean;
}

export class GatewayMcpManager {
  private readonly configs: GatewayMcpServerConfig[];
  private readonly clients = new Map<string, GatewayMcpClient>();
  private readonly statuses = new Map<string, GatewayMcpServerStatus>();
  private readonly tools = new Map<string, GatewayMcpToolInfo[]>();
  private readonly lazy: boolean;
  private connecting = new Map<string, Promise<void>>();
  private initialized = false;

  /**
   * 根据配置初始化所有服务的基础状态。
   *
   * 即使此时还没真正连接，也先给每个配置项准备一份默认状态，
   * 这样状态查询接口在任何时刻都有稳定输出。
   */
  constructor(
    configs: GatewayMcpServerConfig[],
    private readonly sandbox?: GatewaySandbox,
    options?: GatewayMcpManagerOptions
  ) {
    this.configs = configs;
    this.lazy = options?.lazy ?? false;

    for (const config of this.configs) {
      this.statuses.set(config.id, {
        id: config.id,
        name: config.name,
        enabled: config.enabled,
        connected: false,
        toolCount: 0,
        launchMode:
          config.isolation?.enabled && config.isolation.mode === "restricted"
            ? "managed-runner"
            : "direct",
        isolationMode: !config.isolation?.enabled ? "off" : config.isolation.mode,
        runtimeRoot: config.isolation?.runtimeRoot,
        cwd: config.cwd,
        command: config.command,
        phase: config.enabled ? "configured" : "disabled",
      });
    }
  }

  /**
   * 判断当前是否配置了至少一个 MCP 服务。
   */
  hasConfiguredServers(): boolean {
    return this.configs.length > 0;
  }

  /**
   * 确保指定服务已连接（懒加载模式下使用）。
   *
   * 如果服务尚未连接，则触发连接；如果正在连接中，则等待已有连接完成。
   * 非懒加载模式下直接返回（connectEnabledServers 已处理）。
   */
  async ensureServerConnected(serverId: string): Promise<void> {
    if (!this.lazy) {
      return;
    }

    const existing = this.clients.get(serverId);
    if (existing && existing.getStatus().connected) {
      return;
    }

    const ongoing = this.connecting.get(serverId);
    if (ongoing) {
      return ongoing;
    }

    const config = this.configs.find((c) => c.id === serverId);
    if (!config || !config.enabled) {
      return;
    }

    const promise = this.connectSingleServer(config);
    this.connecting.set(serverId, promise);

    try {
      await promise;
    } finally {
      this.connecting.delete(serverId);
    }
  }

  /**
   * 连接所有启用状态的 MCP 服务。
   *
   * 懒加载模式下跳过（由 ensureServerConnected 按需连接）。
   * 某一台连接失败不会影响其他服务继续连接，
   * 失败信息会被记录进各自状态中供后续查看。
   */
  async connectEnabledServers(): Promise<void> {
    if (this.lazy) {
      this.initialized = true;
      return;
    }
    for (const config of this.configs) {
      await this.connectSingleServer(config);
    }
  }

  /**
   * 方法 `connectSingleServer` 的职责说明。
   * `connectSingleServer` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private async connectSingleServer(config: GatewayMcpServerConfig): Promise<void> {
    if (!config.enabled) {
      this.statuses.set(config.id, {
        id: config.id,
        name: config.name,
        enabled: false,
        connected: false,
        toolCount: 0,
        launchMode:
          config.isolation?.enabled && config.isolation.mode === "restricted"
            ? "managed-runner"
            : "direct",
        isolationMode: !config.isolation?.enabled ? "off" : config.isolation.mode,
        runtimeRoot: config.isolation?.runtimeRoot,
        cwd: config.cwd,
        command: config.command,
        phase: "disabled",
      });
      return;
    }

    const sandboxDecision = this.sandbox?.canConnectMcpServer(config);
    if (sandboxDecision && !sandboxDecision.allowed) {
      this.statuses.set(config.id, {
        ...(this.statuses.get(config.id) ?? {
          id: config.id,
          name: config.name,
          enabled: config.enabled,
          connected: false,
          toolCount: 0,
        }),
        connected: false,
        phase: "blocked",
        error: sandboxDecision.reason,
      });
      return;
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

  /**
   * 发现并注册所有已连接 MCP 服务的工具。
   *
   * 注册过程分为两步：
   * 1. 让客户端发现远端工具。
   * 2. 把这些工具适配成 GatewayTool 后注册到 ToolRegistry。
   */
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

  async addOrUpdateServer(
    config: GatewayMcpServerConfig,
    registry: ToolRegistry
  ): Promise<GatewayMcpServerStatus> {
    const existingIndex = this.configs.findIndex((item) => item.id === config.id);
    if (existingIndex >= 0) {
      this.configs[existingIndex] = config;
      const existingClient = this.clients.get(config.id);
      if (existingClient) {
        try {
          await existingClient.close();
        } catch {
          // replacing a server should not fail because the old process refused to close
        }
      }
      this.clients.delete(config.id);
      this.tools.delete(config.id);
    } else {
      this.configs.push(config);
    }

    this.statuses.set(config.id, {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      connected: false,
      toolCount: 0,
      launchMode:
        config.isolation?.enabled && config.isolation.mode === "restricted"
          ? "managed-runner"
          : "direct",
      isolationMode: !config.isolation?.enabled ? "off" : config.isolation.mode,
      runtimeRoot: config.isolation?.runtimeRoot,
      cwd: config.cwd,
      command: config.command,
      phase: config.enabled ? "configured" : "disabled",
    });

    await this.connectSingleServer(config);
    const client = this.clients.get(config.id);
    const status = this.statuses.get(config.id);
    if (!client || !status?.connected) {
      return this.statuses.get(config.id)!;
    }

    try {
      const discoveredTools = await client.listTools();
      this.tools.set(config.id, discoveredTools);
      const gatewayTools = await createGatewayToolsFromMcpClient(client);
      let registeredCount = 0;

      for (const tool of gatewayTools) {
        try {
          registry.register(tool);
          registeredCount += 1;
        } catch {
          // Duplicate tool names can happen when replacing a running server.
        }
      }

      const nextStatus = {
        ...client.getStatus(),
        toolCount: registeredCount,
      };
      this.statuses.set(config.id, nextStatus);
      return nextStatus;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextStatus = {
        ...client.getStatus(),
        connected: false,
        error: `[mcp] failed to discover/register tools: ${message}`,
      };
      this.statuses.set(config.id, nextStatus);
      return nextStatus;
    }
  }

  /**
   * 列出全部 MCP 服务状态。
   *
   * 返回顺序保持与原始配置一致，便于 CLI 输出时和配置文件一一对应。
   */
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

  /**
   * 聚合所有服务已发现的工具列表。
   */
  listTools(): GatewayMcpToolInfo[] {
    const allTools: GatewayMcpToolInfo[] = [];
    for (const tools of this.tools.values()) {
      allTools.push(...tools);
    }
    return allTools;
  }

  /**
   * 关闭全部 MCP 客户端连接。
   *
   * 使用 `Promise.all` 并发关闭，减少退出耗时。
   */
  async close(): Promise<void> {
    const closeTasks = Array.from(this.clients.values()).map(async (client) => {
      try {
        await client.close();
      } catch {
        // 关闭异常只允许被忽略，不能阻断其余客户端回收。
      }
    });

    await Promise.all(closeTasks);
    this.clients.clear();
  }
}
