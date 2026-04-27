import type { GatewayMcpClient } from "./mcpClient";
import type { GatewayTool } from "./toolTypes";

export async function createGatewayToolsFromMcpClient(
  client: GatewayMcpClient
): Promise<GatewayTool[]> {
  const toolInfos = await client.listTools();

  return toolInfos.map((toolInfo) => ({
    name: toolInfo.gatewayToolName,
    description: `[mcp:${toolInfo.serverName}] ${toolInfo.description ?? toolInfo.originalName}`,
    inputSchema: toolInfo.inputSchema,
    async invoke(input) {
      return client.callTool(toolInfo.originalName, input);
    },
  }));
}
