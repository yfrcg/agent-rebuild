/**
 * ?????CS336 ???
 * ???packages/gateway/mcpConfig.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GatewayMcpServerConfig } from "./mcpTypes";

const MCP_CONFIG_FILE_PATH = path.resolve(
  process.cwd(),
  "config",
  "mcp.servers.json"
);

/**
 * 函数 `getHomeDir` 的职责说明。
 * `getHomeDir` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function getHomeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
}

const MCP_CONFIG_SOURCES: string[] = [
  path.join(getHomeDir(), ".agent-rebuild", "mcp.servers.json"),
  MCP_CONFIG_FILE_PATH,
  path.resolve(process.cwd(), ".mcp.json"),
];

interface GatewayMcpConfigFile {
  servers?: unknown;
}

/**
 * 函数 `readJsonFile` 的职责说明。
 * `readJsonFile` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function readJsonFile(filePath: string): unknown | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * 函数 `extractServersFromParsed` 的职责说明。
 * `extractServersFromParsed` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function extractServersFromParsed(parsed: unknown): unknown[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const obj = parsed as Record<string, unknown>;

  if (Array.isArray(obj.servers)) {
    return obj.servers;
  }

  if (obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers)) {
    const mcpServers = obj.mcpServers as Record<string, unknown>;
    return Object.entries(mcpServers).map(([name, config]) => {
      if (config && typeof config === "object" && !Array.isArray(config)) {
        return { id: name, name, ...(config as Record<string, unknown>) };
      }
      return config;
    });
  }

  return [];
}

/**
 * 读取并解析 MCP 服务器配置列表。
 *
 * 从多个配置源加载并合并，后加载的同名配置覆盖先前的：
 * 1. ~/.agent-rebuild/mcp.servers.json (用户级)
 * 2. config/mcp.servers.json (项目级)
 * 3. .mcp.json (项目级兼容格式)
 */
export function loadGatewayMcpServerConfigs(): GatewayMcpServerConfig[] {
  const merged = new Map<string, GatewayMcpServerConfig>();

  for (const configPath of MCP_CONFIG_SOURCES) {
    const parsed = readJsonFile(configPath);
    if (parsed === undefined) {
      continue;
    }

    const serverEntries = extractServersFromParsed(parsed);
    for (let index = 0; index < serverEntries.length; index++) {
      try {
        const config = parseServerConfig(serverEntries[index], index);
        merged.set(config.id, config);
      } catch {
        // skip malformed entries silently
      }
    }
  }

  return Array.from(merged.values());
}

/**
 * 获取所有配置源路径（用于诊断/测试）。
 */
export function getMcpConfigSources(): string[] {
  return [...MCP_CONFIG_SOURCES];
}

export function upsertProjectMcpServerConfig(
  config: GatewayMcpServerConfig
): { configPath: string; servers: GatewayMcpServerConfig[] } {
  const existing = readJsonFile(MCP_CONFIG_FILE_PATH);
  const servers = extractServersFromParsed(existing)
    .map((entry, index) => {
      try {
        return parseServerConfig(entry, index);
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is GatewayMcpServerConfig => Boolean(entry));

  const nextServers = servers.filter((server) => server.id !== config.id);
  nextServers.push(config);

  const dir = path.dirname(MCP_CONFIG_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    MCP_CONFIG_FILE_PATH,
    `${JSON.stringify({ servers: nextServers }, null, 2)}\n`,
    "utf8"
  );

  return {
    configPath: MCP_CONFIG_FILE_PATH,
    servers: nextServers,
  };
}

/**
 * 把单条未知结构的配置项解析成强类型 MCP 服务配置。
 *
 * 这一步是 MCP 配置安全性的关键，负责阻止错误字段一路进入运行时。
 */
function parseServerConfig(value: unknown, index: number): GatewayMcpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[mcp] servers[${index}] must be an object`);
  }

  const item = value as Record<string, unknown>;

  const id = getRequiredString(item.id, `servers[${index}].id`);
  const name = getOptionalString(item.name, `servers[${index}].name`) ?? id;
  const command = getRequiredString(item.command, `servers[${index}].command`);
  const enabled = getOptionalBoolean(item.enabled, `servers[${index}].enabled`) ?? false;
  const transportValue =
    getOptionalString(item.transport, `servers[${index}].transport`) ?? "stdio";

  if (transportValue !== "stdio") {
    throw new Error(
      `[mcp] servers[${index}].transport only supports "stdio" currently, received "${transportValue}"`
    );
  }

  return {
    id,
    name,
    enabled,
    transport: "stdio",
    command,
    args: getOptionalStringArray(item.args, `servers[${index}].args`),
    cwd: getOptionalString(item.cwd, `servers[${index}].cwd`),
    env: getOptionalStringRecord(item.env, `servers[${index}].env`),
    toolNamePrefix:
      getOptionalString(item.toolNamePrefix, `servers[${index}].toolNamePrefix`) ?? `mcp.${id}`,
    isolation: parseIsolationConfig(item.isolation, index),
  };
}

/**
 * 解析必填字符串字段。
 *
 * 这里先复用可选字符串解析逻辑，再补上“不能为空”的约束。
 */
function getRequiredString(value: unknown, fieldPath: string): string {
  const parsed = getOptionalString(value, fieldPath);
  if (!parsed) {
    throw new Error(`[mcp] ${fieldPath} is required and must be a non-empty string`);
  }
  return parsed;
}

/**
 * 解析可选字符串字段。
 *
 * 如果字段缺失则返回 `undefined`，
 * 如果字段存在但不是非空字符串则直接报错。
 */
function getOptionalString(value: unknown, fieldPath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`[mcp] ${fieldPath} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`[mcp] ${fieldPath} must be a non-empty string`);
  }
  return trimmed;
}

/**
 * 解析可选布尔字段。
 */
function getOptionalBoolean(value: unknown, fieldPath: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`[mcp] ${fieldPath} must be a boolean`);
  }
  return value;
}

/**
 * 解析可选字符串数组字段。
 *
 * 常用于命令参数列表 `args`。
 */
function getOptionalStringArray(value: unknown, fieldPath: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`[mcp] ${fieldPath} must be an array of strings`);
  }

  return value.map((item, itemIndex) =>
    getRequiredString(item, `${fieldPath}[${itemIndex}]`)
  );
}

/**
 * 解析可选字符串字典字段。
 *
 * 常用于 `env`，确保所有键值对最终都能安全注入子进程环境变量。
 */
function getOptionalStringRecord(
  value: unknown,
  fieldPath: string
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[mcp] ${fieldPath} must be an object`);
  }

  const record = value as Record<string, unknown>;
  const parsedEntries = Object.entries(record).map(([key, item]) => {
    if (typeof item !== "string") {
      throw new Error(`[mcp] ${fieldPath}.${key} must be a string`);
    }
    return [key, item] as const;
  });

  return Object.fromEntries(parsedEntries);
}

/**
 * 函数 `parseIsolationConfig` 的职责说明。
 * `parseIsolationConfig` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function parseIsolationConfig(
  value: unknown,
  index: number
): GatewayMcpServerConfig["isolation"] {
  if (value === undefined) {
    return {
      enabled: false,
      mode: "inherit",
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[mcp] servers[${index}].isolation must be an object`);
  }

  const item = value as Record<string, unknown>;
  const enabled = getOptionalBoolean(item.enabled, `servers[${index}].isolation.enabled`) ?? true;
  const mode =
    getOptionalString(item.mode, `servers[${index}].isolation.mode`) ?? "restricted";

  if (mode !== "inherit" && mode !== "restricted") {
    throw new Error(
      `[mcp] servers[${index}].isolation.mode must be "inherit" or "restricted"`
    );
  }

  return {
    enabled,
    mode,
    runtimeRoot: getOptionalString(item.runtimeRoot, `servers[${index}].isolation.runtimeRoot`),
    preserveEnvKeys: getOptionalStringArray(
      item.preserveEnvKeys,
      `servers[${index}].isolation.preserveEnvKeys`
    ),
  };
}
