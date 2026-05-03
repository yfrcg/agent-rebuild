import type {
  GatewayTool,
  GatewayToolContext,
  GatewayToolInput,
  GatewayToolListItem,
  GatewayToolName,
  GatewayToolOutput,
} from "./toolTypes";

/**
 * Gateway 的统一工具注册表。
 *
 * 所有本地工具和 MCP 映射工具最终都会注册到这里，
 * 这样调用层只需要面对一个统一的查找与执行入口。
 */
export class ToolRegistry {
  private readonly tools = new Map<GatewayToolName, GatewayTool>();

  /**
   * 注册一个工具。
   *
   * 同名工具会直接抛错，避免后注册的工具悄悄覆盖前一个实现。
   */
  register(tool: GatewayTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`[tools] duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * 判断指定工具是否已存在。
   */
  has(name: GatewayToolName): boolean {
    return this.tools.has(name);
  }

  /**
   * 列出当前所有已注册工具的展示信息。
   */
  list(): GatewayToolListItem[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      policy: tool.policy,
    }));
  }

  /**
   * 获取某个工具的原始定义。
   */
  get(name: GatewayToolName): GatewayTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 调用指定工具。
   *
   * 这里做了两层保护：
   * 1. 工具不存在时返回标准失败结果。
   * 2. 工具内部抛错时转换成统一错误输出，而不是把异常继续往上炸。
   */
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
