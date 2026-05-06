
import { createToolSecurityProfile } from "./toolSecurityProfile";
import { validateToolArgs } from "./toolSchema";
import type {
  GatewayTool,
  GatewayToolContext,
  GatewayToolInput,
  GatewayToolListItem,
  GatewayToolMetadata,
  GatewayToolName,
  GatewayToolOutput,
  ToolDefinition,
  ToolResult,
} from "./toolTypes";
import type { GatewayToolPermissionLevel } from "./permissionTypes";

interface NormalizedGatewayTool
  extends Omit<
      GatewayTool,
      keyof GatewayToolMetadata
    >,
    ToolDefinition,
    GatewayToolMetadata {
  schema?: Record<string, unknown>;
  riskLevel: ToolDefinition["riskLevel"];
  /** 方法 `execute`：负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。 */
  execute(args: unknown, context?: GatewayToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<GatewayToolName, NormalizedGatewayTool>();

  /**
   * 方法 `register` 的职责说明。
   * `register` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  register(tool: GatewayTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`[tools] duplicate tool registration: ${tool.name}`);
    }

    this.tools.set(tool.name, normalizeTool(tool));
  }

  /**
   * 方法 `has` 的职责说明。
   * `has` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  has(name: GatewayToolName): boolean {
    return this.tools.has(name);
  }

  /**
   * 方法 `list` 的职责说明。
   * `list` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  list(): GatewayToolListItem[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      riskLevel: tool.riskLevel,
      inputSchema: tool.inputSchema,
      policy: tool.policy,
      permissionLevel: tool.permissionLevel,
      readOnly: tool.readOnly,
      sideEffect: tool.sideEffect,
      requiresSandbox: tool.requiresSandbox,
      timeoutMs: tool.timeoutMs,
    }));
  }

  /**
   * 方法 `get` 的职责说明。
   * `get` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  get(name: GatewayToolName): NormalizedGatewayTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 方法 `validate` 的职责说明。
   * `validate` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  validate(name: GatewayToolName, input: unknown): string | undefined {
    const tool = this.tools.get(name);
    if (!tool) {
      return `[tools] tool not found: ${name}`;
    }

    return validateToolArgs(tool.schema, input);
  }

  /**
   * 方法 `invoke` 的职责说明。
   * `invoke` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
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
      if (tool.invoke) {
        return await tool.invoke(input, context);
      }

      const result = await tool.execute(input, context);
      return {
        ok: result.ok,
        content: result.result,
        error: result.error,
        metadata:
          result.durationMs === undefined
            ? undefined
            : {
                durationMs: result.durationMs,
              },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `[tools] invoke failed: ${name}. ${message}`,
      };
    }
  }
}

/**
 * 函数 `normalizeTool` 的职责说明。
 * `normalizeTool` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function normalizeTool(tool: GatewayTool): NormalizedGatewayTool {
  const schema = tool.schema ?? tool.inputSchema;
  const riskLevel = tool.riskLevel ?? inferRiskLevel(tool);
  const metadata = inferToolMetadata(tool);

  const execute =
    tool.execute ??
    (async (args: unknown, context?: GatewayToolContext): Promise<ToolResult> => {
      if (!tool.invoke) {
        throw new Error(`[tools] ${tool.name} does not define execute() or invoke()`);
      }

      const output = await tool.invoke(args as GatewayToolInput, context);
      return {
        toolCallId: "",
        ok: output.ok,
        result: output.content,
        error: output.error,
        durationMs:
          typeof output.metadata?.durationMs === "number"
            ? output.metadata.durationMs
            : undefined,
      };
    });

  return {
    ...tool,
    schema,
    riskLevel,
    ...metadata,
    security: tool.security ?? securityFromRiskLevel(riskLevel),
    execute,
  };
}

/**
 * 函数 `inferToolMetadata` 的职责说明。
 * `inferToolMetadata` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function inferToolMetadata(tool: GatewayTool): GatewayToolMetadata {
  const permissionLevel = tool.permissionLevel ?? inferPermissionLevel(tool);
  const readOnly = tool.readOnly ?? permissionLevel === "read";
  const requiresSandbox =
    tool.requiresSandbox ??
    Boolean(tool.sandboxSpec || tool.security?.sandboxRequired);
  const sideEffect = tool.sideEffect ?? !readOnly;

  return {
    permissionLevel,
    readOnly,
    sideEffect,
    requiresSandbox,
    timeoutMs: tool.timeoutMs,
  };
}

/**
 * 函数 `inferRiskLevel` 的职责说明。
 * `inferRiskLevel` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function inferRiskLevel(tool: GatewayTool): ToolDefinition["riskLevel"] {
  if (tool.policy?.riskLevel === "destructive") {
    return "dangerous";
  }

  if (
    tool.policy?.riskLevel === "stateful" ||
    tool.security?.riskLevel === "medium" ||
    tool.security?.riskLevel === "high"
  ) {
    return "medium";
  }

  return "safe";
}

/**
 * 函数 `inferPermissionLevel` 的职责说明。
 * `inferPermissionLevel` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function inferPermissionLevel(
  tool: GatewayTool
): GatewayToolPermissionLevel {
  if (/^memory\.(search|get)$/.test(tool.name) || /^file\.(read|list)$/.test(tool.name)) {
    return "read";
  }

  if (/^memory\.write$/.test(tool.name) || /^file\.(write|edit)$/.test(tool.name)) {
    return "write";
  }

  if (
    /^shell\.run$/.test(tool.name) ||
    /^bash\.run$/.test(tool.name) ||
    /^sandbox\.exec$/.test(tool.name) ||
    /^run_test$/.test(tool.name) ||
    /^npm_test$/.test(tool.name) ||
    /^build$/.test(tool.name)
  ) {
    return "execute";
  }

  if (/plan/i.test(tool.name)) {
    return "plan";
  }

  return "advanced";
}

/**
 * 函数 `securityFromRiskLevel` 的职责说明。
 * `securityFromRiskLevel` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function securityFromRiskLevel(
  riskLevel: ToolDefinition["riskLevel"]
): NonNullable<GatewayTool["security"]> {
  switch (riskLevel) {
    case "dangerous":
      return createToolSecurityProfile({
        riskLevel: "medium",
        sandboxRequired: true,
        allowWrite: true,
        allowHostExecution: false,
        requireApproval: false,
      });
    case "medium":
      return createToolSecurityProfile({
        riskLevel: "medium",
        sandboxRequired: false,
        allowWrite: true,
        allowHostExecution: true,
        requireApproval: false,
      });
    case "safe":
    default:
      return createToolSecurityProfile({
        riskLevel: "safe",
        sandboxRequired: false,
        allowWrite: false,
        allowHostExecution: true,
        requireApproval: false,
      });
  }
}
