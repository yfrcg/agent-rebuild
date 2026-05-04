function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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
