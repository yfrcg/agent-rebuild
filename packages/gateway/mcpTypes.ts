export type GatewayMcpTransportType = "stdio";

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
}

export interface GatewayMcpToolInfo {
  serverId: string;
  serverName: string;
  originalName: string;
  gatewayToolName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface GatewayMcpServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  error?: string;
}
