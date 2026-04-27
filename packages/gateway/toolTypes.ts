export type GatewayToolName = string;

export type GatewayToolInput = Record<string, unknown>;

export interface GatewayToolOutput {
  ok: boolean;
  content?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface GatewayToolContext {
  sessionId?: string;
  requestId?: string;
}

export interface GatewayTool {
  name: GatewayToolName;
  description: string;
  inputSchema?: Record<string, unknown>;
  invoke(
    input: GatewayToolInput,
    context?: GatewayToolContext
  ): Promise<GatewayToolOutput>;
}

export interface GatewayToolListItem {
  name: GatewayToolName;
  description: string;
  inputSchema?: Record<string, unknown>;
}
