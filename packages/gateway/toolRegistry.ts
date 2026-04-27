import type {
  GatewayTool,
  GatewayToolContext,
  GatewayToolInput,
  GatewayToolListItem,
  GatewayToolName,
  GatewayToolOutput,
} from "./toolTypes";

export class ToolRegistry {
  private readonly tools = new Map<GatewayToolName, GatewayTool>();

  register(tool: GatewayTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`[tools] duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: GatewayToolName): boolean {
    return this.tools.has(name);
  }

  list(): GatewayToolListItem[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  get(name: GatewayToolName): GatewayTool | undefined {
    return this.tools.get(name);
  }

  async invoke(
    name: GatewayToolName,
    input: GatewayToolInput,
    context?: GatewayToolContext
  ): Promise<GatewayToolOutput> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        error: `[tools] tool not found: ${name}`,
      };
    }

    try {
      return await tool.invoke(input, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `[tools] invoke failed: ${name}. ${message}`,
      };
    }
  }
}
