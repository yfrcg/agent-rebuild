import type { GatewayMcpClient } from "./mcpClient";
import { securityProfileFromLegacyPolicy } from "./toolSecurityProfile";
import type { GatewayTool } from "./toolTypes";

/**
 * 把某个 MCP 客户端暴露的工具列表转换成 Gateway 自己的工具格式。
 *
 * 这样做的意义是把“外部 MCP 协议”和“内部工具调用协议”隔离开，
 * Gateway 其余部分只需要面对统一的 `GatewayTool` 即可。
 */
export async function createGatewayToolsFromMcpClient(
  client: GatewayMcpClient
): Promise<GatewayTool[]> {
  const toolInfos = await client.listTools();

  return toolInfos.map((toolInfo) => ({
    name: toolInfo.gatewayToolName,
    description: `[mcp:${toolInfo.serverName}] ${toolInfo.description ?? toolInfo.originalName}`,
    inputSchema: toolInfo.inputSchema,
    policy: {
      automationLevel: toolInfo.automationLevel ?? "confirm",
      riskLevel: toolInfo.riskLevel ?? "external-read",
      ...(toolInfo.confirmationMessage
        ? { confirmationMessage: toolInfo.confirmationMessage }
        : {}),
      tags: ["mcp", toolInfo.serverId],
    },
    security: securityProfileFromLegacyPolicy({
      automationLevel: toolInfo.automationLevel ?? "confirm",
      riskLevel: toolInfo.riskLevel ?? "external-read",
      ...(toolInfo.confirmationMessage
        ? { confirmationMessage: toolInfo.confirmationMessage }
        : {}),
    }),

    /**
     * 转发 Gateway 工具调用到真实的 MCP 工具。
     *
     * 这里保留了“Gateway 工具名”和“原始 MCP 工具名”的映射关系，
     * 从而让上层调用统一、下层执行精准。
     */
    async invoke(input) {
      return client.callTool(toolInfo.originalName, input);
    },
  }));
}
