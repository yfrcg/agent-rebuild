/**
 * 当前 Gateway 支持的 MCP 传输方式。
 *
 * 现阶段只支持通过子进程标准输入输出进行通信。
 */
export type GatewayMcpTransportType = "stdio";

export interface GatewayMcpIsolationConfig {
  enabled: boolean;
  mode: "inherit" | "restricted";
  runtimeRoot?: string;
  preserveEnvKeys?: string[];
}

/**
 * 单个 MCP 服务的配置结构。
 */
export interface GatewayMcpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: GatewayMcpTransportType;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  toolNamePrefix?: string;
  isolation?: GatewayMcpIsolationConfig;
}

/**
 * 一个 MCP 工具在 Gateway 侧的描述信息。
 */
export interface GatewayMcpToolInfo {
  serverId: string;
  serverName: string;
  originalName: string;
  gatewayToolName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  automationLevel?: "auto" | "confirm" | "manual";
  riskLevel?: "read-only" | "external-read" | "stateful" | "destructive";
  confirmationMessage?: string;
}

/**
 * MCP 服务运行状态快照。
 */
export interface GatewayMcpServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  launchMode?: "direct" | "managed-runner";
  isolationMode?: "off" | "inherit" | "restricted";
  phase?: "configured" | "blocked" | "connecting" | "connected" | "failed" | "disabled";
  runtimeRoot?: string;
  cwd?: string;
  command?: string;
  error?: string;
}
