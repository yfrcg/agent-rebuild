
/** 函数 `isPlainObject`：负责完成当前模块中的一个明确步骤，维护时要关注输入校验、返回结构和异常路径。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 函数 `validateToolArgs` 的职责说明。
 * `validateToolArgs` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function validateToolArgs(
  schema: Record<string, unknown> | undefined,
  value: unknown,
  path = "args"
): string | undefined {
  if (!schema) {
    return undefined;
  }

  const schemaType = typeof schema.type === "string" ? schema.type : undefined;

  if (schemaType === "object") {
    if (!isPlainObject(value)) {
      return `${path} must be an object`;
    }

    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!(key in value)) {
        return `${path}.${key} is required`;
      }
    }

    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value)) {
        continue;
      }

      if (!isPlainObject(propertySchema)) {
        continue;
      }

      const error = validateToolArgs(
        propertySchema,
        value[key],
        `${path}.${key}`
      );
      if (error) {
        return error;
      }
    }

    return undefined;
  }

  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      return `${path} must be an array`;
    }

    const itemSchema = isPlainObject(schema.items) ? schema.items : undefined;
    if (!itemSchema) {
      return undefined;
    }

    for (let index = 0; index < value.length; index += 1) {
      const error = validateToolArgs(itemSchema, value[index], `${path}[${index}]`);
      if (error) {
        return error;
      }
    }

    return undefined;
  }

  if (schemaType === "string") {
    if (typeof value !== "string") {
      return `${path} must be a string`;
    }
  } else if (schemaType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `${path} must be a finite number`;
    }
  } else if (schemaType === "boolean") {
    if (typeof value !== "boolean") {
      return `${path} must be a boolean`;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path} must be one of: ${schema.enum.join(", ")}`;
  }

  return undefined;
}
