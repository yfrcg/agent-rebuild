/**
 * ?????CS336 ???
 * ???packages/gateway/env.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 读取并注入本地 `.env` 文件。
 *
 * 这是一个轻量版环境变量加载器，目标是覆盖项目常见需求：
 * - 支持 `KEY=VALUE` 的基础格式。
 * - 忽略空行和注释行。
 * - 已存在于 `process.env` 的变量不重复覆盖。
 */
export function loadEnvFile(filePath = ".env"): void {
  const absolutePath = resolve(process.cwd(), filePath);

  // `.env` 不存在时静默返回，便于不同环境按需使用。
  if (!existsSync(absolutePath)) {
    return;
  }

  const content = readFileSync(absolutePath, "utf-8");

  // 同时兼容 Windows 的 `\r\n` 和 Unix 的 `\n` 换行。
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    const rawValue = trimmed.slice(equalIndex + 1).trim();

    if (!key) {
      continue;
    }

    // 如果外部环境已经明确设置过值，则尊重外部配置优先级。
    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = unwrapEnvValue(rawValue);
  }
}

/**
 * 去掉包裹在环境变量值外层的引号。
 *
 * 比如：
 * - `"abc"` 会变成 `abc`
 * - `'abc'` 会变成 `abc`
 * - `abc` 则保持原样
 */
function unwrapEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
