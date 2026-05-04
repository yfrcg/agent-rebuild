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
  execute(args: unknown, context?: GatewayToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<GatewayToolName, NormalizedGatewayTool>();

  register(tool: GatewayTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`[tools] duplicate tool registration: ${tool.name}`);
    }

    this.tools.set(tool.name, normalizeTool(tool));
  }

  has(name: GatewayToolName): boolean {
    return this.tools.has(name);
  }

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

  get(name: GatewayToolName): NormalizedGatewayTool | undefined {
    return this.tools.get(name);
  }

  validate(name: GatewayToolName, input: unknown): string | undefined {
    const tool = this.tools.get(name);
    if (!tool) {
      return `[tools] tool not found: ${name}`;
    }

    return validateToolArgs(tool.schema, input);
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
