
const SECRET_KEY_PATTERN =
  /(api[_-]?key|token|authorization|cookie|password|secret|private[_-]?key|ssh[_-]?key)/i;

/** 对任意 JSON 兼容结构做递归脱敏，并尽量保持原始结构形状。 */
export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
}

/**
 * 递归处理数组、对象和字符串。
 *
 * 命中敏感字段名时直接替换整个值；普通字符串则继续扫描常见密钥文本。
 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      return redactSecretText(value);
    }
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redact(child);
    }
  }
  return output;
}

/** 对字符串中的 Bearer token、OpenAI 风格 key 和 PEM 私钥块做脱敏。 */
function redactSecretText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{12,}/g, "sk-[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}
