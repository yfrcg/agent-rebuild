import * as fs from "node:fs";
import * as path from "node:path";

import type { GatewayMcpServerConfig } from "./mcpTypes";

const MCP_CONFIG_FILE_PATH = path.resolve(
  process.cwd(),
  "config",
  "mcp.servers.json"
);

interface GatewayMcpConfigFile {
  servers?: unknown;
}

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
  };
}

function getRequiredString(value: unknown, fieldPath: string): string {
  const parsed = getOptionalString(value, fieldPath);
  if (!parsed) {
    throw new Error(`[mcp] ${fieldPath} is required and must be a non-empty string`);
  }
  return parsed;
}

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

function getOptionalBoolean(value: unknown, fieldPath: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`[mcp] ${fieldPath} must be a boolean`);
  }
  return value;
}

function getOptionalStringArray(value: unknown, fieldPath: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`[mcp] ${fieldPath} must be an array of strings`);
  }

  const parsed = value.map((item, itemIndex) =>
    getRequiredString(item, `${fieldPath}[${itemIndex}]`)
  );

  return parsed;
}

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
