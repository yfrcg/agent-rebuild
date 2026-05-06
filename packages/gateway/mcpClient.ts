
import * as fs from "node:fs";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { GatewayToolOutput } from "./toolTypes";
import type {
  GatewayMcpServerConfig,
  GatewayMcpServerStatus,
  GatewayMcpToolInfo,
} from "./mcpTypes";

/**
 * Gateway 作为 MCP 客户端对外宣告的身份信息。
 *
 * 这会出现在与 MCP 服务建立连接时的握手阶段，
 * 方便服务端识别是哪个客户端在接入。
 */
const GATEWAY_CLIENT_INFO = {
  name: "agent-rebuild-gateway",
  version: "0.5.0",
};

const MCP_RUNNER_PATH = path.resolve(process.cwd(), "scripts", "mcp-runner.js");

/**
 * 单个 MCP 服务的客户端封装。
 *
 * 这个类负责：
 * - 建立 stdio 连接
 * - 拉取工具列表
 * - 调用远端工具
 * - 维护连接状态与缓存
 */
export class GatewayMcpClient {
  private readonly config: GatewayMcpServerConfig;
  private client?: Client;
  private transport?: StdioClientTransport;
  private status: GatewayMcpServerStatus;
  private toolsCache: GatewayMcpToolInfo[] = [];

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(config: GatewayMcpServerConfig) {
    this.config = config;
    const launch = describeMcpLaunch(config);
    this.status = {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      connected: false,
      toolCount: 0,
      launchMode: launch.launchMode,
      isolationMode: launch.isolationMode,
      runtimeRoot: launch.runtimeRoot,
      cwd: launch.cwd,
      command: launch.command,
      phase: config.enabled ? "configured" : "disabled",
    };
  }

  /**
   * 与目标 MCP 服务建立连接。
   *
   * 这里只在尚未连接时真正发起连接动作，
   * 避免重复调用把同一个服务连接多次。
   */
  async connect(): Promise<void> {
    if (this.status.connected) {
      return;
    }

    this.status.error = undefined;
    this.status.phase = "connecting";

    try {
      const validation = validateMcpLaunch(this.config);
      if (!validation.ok) {
        this.status.connected = false;
        this.status.phase = "failed";
        this.status.error = validation.error;
        throw new Error(validation.error);
      }

      this.transport = new StdioClientTransport(
        buildTransportOptions(this.config)
      );
      this.client = new Client(GATEWAY_CLIENT_INFO, {
        capabilities: {},
      });
      await this.client.connect(this.transport);
      this.status.connected = true;
      this.status.phase = "connected";
    } catch (err) {
      this.status.connected = false;
      this.status.phase = "failed";
      this.status.error = toErrorMessage(err);
      throw new Error(
        `[mcp] failed to connect server "${this.config.id}" (${this.config.name}): ${this.status.error}`
      );
    }
  }

  /**
   * 获取远端服务暴露的工具列表。
   *
   * 第一次调用会向 MCP 服务真实请求；
   * 后续调用则优先走本地缓存，减少重复握手和网络成本。
   */
  async listTools(): Promise<GatewayMcpToolInfo[]> {
    if (this.toolsCache.length > 0) {
      return [...this.toolsCache];
    }

    if (!this.client || !this.status.connected) {
      throw new Error(
        `[mcp] server "${this.config.id}" is not connected, cannot list tools`
      );
    }

    const response = await this.client.listTools();
    const toolNamePrefix = this.config.toolNamePrefix ?? `mcp.${this.config.id}`;

    this.toolsCache = response.tools.map((tool) => ({
      serverId: this.config.id,
      serverName: this.config.name,
      originalName: tool.name,
      gatewayToolName: `${toolNamePrefix}.${tool.name}`,
      description: tool.description,
      ...inferMcpToolPolicy(tool.name, tool.description),
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as Record<string, unknown>)
          : undefined,
    }));

    this.status.toolCount = this.toolsCache.length;
    return [...this.toolsCache];
  }

  /**
   * 调用某个 MCP 工具。
   *
   * 返回值被转换成 Gateway 统一工具输出格式，
   * 这样上层不必感知 MCP SDK 的原始响应细节。
   */
  async callTool(
    originalName: string,
    input: Record<string, unknown>
  ): Promise<GatewayToolOutput> {
    if (!this.client || !this.status.connected) {
      return {
        ok: false,
        error: `[mcp] server "${this.config.id}" is not connected`,
        metadata: {
          serverId: this.config.id,
          originalToolName: originalName,
        },
      };
    }

    try {
      const result = await this.client.callTool({
        name: originalName,
        arguments: input,
      });

      if ("isError" in result && result.isError) {
        return {
          ok: false,
          error: extractToolError(result),
          content:
            "structuredContent" in result && result.structuredContent !== undefined
              ? result.structuredContent
              : "content" in result
                ? result.content
                : undefined,
          metadata: {
            serverId: this.config.id,
            originalToolName: originalName,
          },
        };
      }

      const content =
        "structuredContent" in result && result.structuredContent !== undefined
          ? result.structuredContent
          : "content" in result
            ? result.content
            : "toolResult" in result
              ? result.toolResult
              : undefined;

      return {
        ok: true,
        content,
        metadata: {
          serverId: this.config.id,
          originalToolName: originalName,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: `[mcp] callTool failed: ${toErrorMessage(err)}`,
        metadata: {
          serverId: this.config.id,
          originalToolName: originalName,
        },
      };
    }
  }

  /**
   * 关闭当前 MCP 客户端连接。
   *
   * 即使关闭过程某一步失败，也不会继续抛错，
   * 因为关闭阶段的目标是“尽力释放资源”，而不是影响主进程退出。
   */
  async close(): Promise<void> {
    this.toolsCache = [];
    this.status.toolCount = 0;
    this.status.connected = false;
    this.status.phase = this.config.enabled ? "configured" : "disabled";

    try {
      await this.client?.close();
    } catch {
      // 关闭异常只记录为忽略，不影响整体退出流程。
    }

    try {
      await this.transport?.close();
    } catch {
      // 关闭异常只记录为忽略，不影响整体退出流程。
    }

    this.client = undefined;
    this.transport = undefined;
  }

  /**
   * 返回当前客户端状态的副本。
   *
   * 通过返回浅拷贝避免外部误改内部状态对象。
   */
  getStatus(): GatewayMcpServerStatus {
    return { ...this.status };
  }
}

/**
 * 函数 `describeMcpLaunch` 的职责说明。
 * `describeMcpLaunch` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function describeMcpLaunch(config: GatewayMcpServerConfig): {
  launchMode: "direct" | "managed-runner";
  isolationMode: "off" | "inherit" | "restricted";
  runtimeRoot?: string;
  cwd?: string;
  command: string;
} {
  const runtime = prepareIsolationRuntime(config);
  const managed = Boolean(config.isolation?.enabled && config.isolation.mode === "restricted");
  return {
    launchMode: managed ? "managed-runner" : "direct",
    isolationMode: !config.isolation?.enabled ? "off" : config.isolation.mode,
    runtimeRoot: runtime?.runtimeRoot,
    cwd: runtime?.workDir ?? config.cwd,
    command: managed ? process.execPath : config.command,
  };
}

/**
 * 函数 `buildTransportOptions` 的职责说明。
 * `buildTransportOptions` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function buildTransportOptions(config: GatewayMcpServerConfig): {
  command: string;
  args?: string[];
  cwd?: string;
  env: Record<string, string>;
} {
  const runtime = prepareIsolationRuntime(config);

  if (config.isolation?.enabled && config.isolation.mode === "restricted") {
    return buildRunnerTransportOptions(config, runtime);
  }

  return {
    command: config.command,
    args: config.args,
    cwd: runtime?.workDir ?? config.cwd,
    env: mergeEnv(config, runtime),
  };
}

/**
 * 函数 `validateMcpLaunch` 的职责说明。
 * `validateMcpLaunch` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function validateMcpLaunch(config: GatewayMcpServerConfig): {
  ok: boolean;
  error?: string;
} {
  const resolved = resolveExecutablePath(config.command, config.isolation?.preserveEnvKeys);
  if (!resolved) {
    return {
      ok: false,
      error: `[mcp] launch validation failed: command not found: ${config.command}`,
    };
  }

  return { ok: true };
}

/**
 * 合并当前进程环境变量与 MCP 服务器自定义环境变量。
 *
 * 自定义值优先级更高，便于对单个 MCP 服务做专属覆盖。
 */
function mergeEnv(
  config: GatewayMcpServerConfig,
  runtime = prepareIsolationRuntime(config)
): Record<string, string> {
  const override = config.env;
  const base: Record<string, string> = {};

  if (config.isolation?.enabled && config.isolation.mode === "restricted") {
    const keys = config.isolation.preserveEnvKeys ?? [
      "PATH",
      "SYSTEMROOT",
      "COMSPEC",
      "PATHEXT",
      "WINDIR",
    ];

    for (const key of keys) {
      const value = process.env[key];
      if (typeof value === "string") {
        base[key] = value;
      }
    }
  } else {
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") {
        base[key] = value;
      }
    }
  }
  if (runtime) {
    base.HOME = runtime.homeDir;
    base.USERPROFILE = runtime.homeDir;
    base.TMP = runtime.tmpDir;
    base.TEMP = runtime.tmpDir;
    base.APPDATA = runtime.homeDir;
    base.LOCALAPPDATA = runtime.homeDir;
  }

  return {
    ...base,
    ...(override ?? {}),
  };
}

/**
 * 函数 `prepareIsolationRuntime` 的职责说明。
 * `prepareIsolationRuntime` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function prepareIsolationRuntime(config: GatewayMcpServerConfig):
  | {
      runtimeRoot: string;
      homeDir: string;
      tmpDir: string;
      workDir: string;
    }
  | undefined {
  if (!config.isolation?.enabled) {
    return undefined;
  }

  const runtimeRoot = path.resolve(
    process.cwd(),
    config.isolation.runtimeRoot ?? path.join("workspace", "sandbox", "mcp", config.id)
  );
  const homeDir = path.join(runtimeRoot, "home");
  const tmpDir = path.join(runtimeRoot, "tmp");
  const workDir = config.cwd ? path.resolve(config.cwd) : runtimeRoot;

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });

  return {
    runtimeRoot,
    homeDir,
    tmpDir,
    workDir,
  };
}

/**
 * 函数 `resolveExecutablePath` 的职责说明。
 * `resolveExecutablePath` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function resolveExecutablePath(
  command: string,
  preserveEnvKeys?: string[]
): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.includes("\\") || trimmed.includes("/") || path.isAbsolute(trimmed)) {
    return fs.existsSync(trimmed) ? path.resolve(trimmed) : undefined;
  }

  const pathValue =
    process.env[
      preserveEnvKeys?.find((key) => key.toUpperCase() === "PATH") ?? "PATH"
    ] ?? "";
  const pathExtValue = process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  const pathDirs = pathValue.split(path.delimiter).filter(Boolean);
  const pathExts =
    process.platform === "win32"
      ? pathExtValue.split(";").filter(Boolean)
      : [""];

  for (const dir of pathDirs) {
    const base = path.join(dir, trimmed);
    if (fs.existsSync(base)) {
      return base;
    }

    for (const ext of pathExts) {
      const candidate = `${base}${ext}`;
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

/**
 * 函数 `buildRunnerTransportOptions` 的职责说明。
 * `buildRunnerTransportOptions` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function buildRunnerTransportOptions(
  config: GatewayMcpServerConfig,
  runtime:
    | {
        runtimeRoot: string;
        homeDir: string;
        tmpDir: string;
        workDir: string;
      }
    | undefined
): {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
} {
  const childEnv = mergeEnv(
    {
      ...config,
      isolation: {
        ...config.isolation,
        enabled: false,
        mode: config.isolation?.mode ?? "inherit",
      },
    },
    runtime
  );
  const payload = Buffer.from(
    JSON.stringify({
      command: config.command,
      args: config.args ?? [],
      cwd: runtime?.workDir ?? config.cwd,
      env: childEnv,
    }),
    "utf8"
  ).toString("base64");

  return {
    command: process.execPath,
    args: [MCP_RUNNER_PATH, payload],
    cwd: runtime?.runtimeRoot ?? config.cwd,
    env: childEnv,
  };
}

/**
 * 把未知异常对象转换成稳定字符串。
 */
function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 从 MCP 错误响应中尽量提取更可读的文本原因。
 *
 * 如果服务返回了结构化文本块，就把文本块拼出来；
 * 否则回退到通用错误提示。
 */
function extractToolError(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "MCP tool returned error";
  }

  const response = result as { content?: unknown };
  if (Array.isArray(response.content)) {
    const textBlocks = response.content
      .filter(
        (item): item is { type: string; text: string } =>
          !!item &&
          typeof item === "object" &&
          "type" in item &&
          (item as { type?: unknown }).type === "text" &&
          "text" in item &&
          typeof (item as { text?: unknown }).text === "string"
      )
      .map((item) => item.text.trim())
      .filter(Boolean);

    if (textBlocks.length > 0) {
      return textBlocks.join(" | ");
    }
  }

  return "MCP tool returned isError=true";
}

/**
 * 函数 `inferMcpToolPolicy` 的职责说明。
 * `inferMcpToolPolicy` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function inferMcpToolPolicy(name: string, description?: string): Pick<
  GatewayMcpToolInfo,
  "automationLevel" | "riskLevel" | "confirmationMessage"
> {
  const corpus = `${name} ${description ?? ""}`.toLowerCase();

  if (/\b(create|update|delete|remove|write|save|mutate|post|put|patch|insert)\b/.test(corpus)) {
    return {
      automationLevel: "manual",
      riskLevel: "destructive",
      confirmationMessage: "This MCP tool may change external state and should be run manually.",
    };
  }

  if (/\b(open|run|execute|trigger|start|stop|publish|deploy)\b/.test(corpus)) {
    return {
      automationLevel: "confirm",
      riskLevel: "stateful",
      confirmationMessage: "This MCP tool may have side effects and should be confirmed first.",
    };
  }

  if (/\b(search|list|get|read|fetch|query|find|lookup|browse)\b/.test(corpus)) {
    return {
      automationLevel: "auto",
      riskLevel: "external-read",
    };
  }

  return {
    automationLevel: "confirm",
    riskLevel: "external-read",
    confirmationMessage: "This MCP tool is not classified as safe auto-read, so confirmation is required.",
  };
}
