import * as fs from "node:fs";
import * as path from "node:path";

import type { GatewayMcpServerConfig } from "./mcpTypes";

/**
 * MCP 服务器配置文件的固定位置。
 *
 * 这里使用项目根目录下的 `config/mcp.servers.json`，
 * 方便把可共享的服务器配置独立于代码维护。
 */
const MCP_CONFIG_FILE_PATH = path.resolve(
  process.cwd(),
  "config",
  "mcp.servers.json"
);

interface GatewayMcpConfigFile {
  servers?: unknown;
}

/**
 * 读取并解析 MCP 服务器配置列表。
 *
 * 解析过程分为三步：
 * 1. 读文件。
 * 2. 解析 JSON。
 * 3. 逐条校验每个服务项的字段合法性。
 */
export function loadGatewayMcpServerConfigs(): GatewayMcpServerConfig[] {
  if (!fs.existsSync(MCP_CONFIG_FILE_PATH)) {
    return [];
  }

  let rawText = "";
  try {
    rawText = fs.readFileSync(MCP_CONFIG_FILE_PATH, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[mcp] failed to read config file: ${MCP_CONFIG_FILE_PATH}. ${message}`);
  }

  let parsed: GatewayMcpConfigFile;
  try {
    parsed = JSON.parse(rawText) as GatewayMcpConfigFile;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[mcp] invalid JSON in ${MCP_CONFIG_FILE_PATH}. ${message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`[mcp] invalid config shape in ${MCP_CONFIG_FILE_PATH}`);
  }

  if (parsed.servers === undefined) {
    return [];
  }

  if (!Array.isArray(parsed.servers)) {
    throw new Error(`[mcp] "servers" must be an array in ${MCP_CONFIG_FILE_PATH}`);
  }

  return parsed.servers.map((server, index) => parseServerConfig(server, index));
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
