export type GatewayCommandType =
  | "exit"
  | "help"
  | "flush"
  | "recover"
  | "remember"
  | "search-memory"
  | "read-file"
  | "session"
  | "mcp"
  | "tools"
  | "tool"
  | "chat";

export interface ParsedGatewayCommand {
  type: GatewayCommandType;
  raw: string;
  payload?: string;
}

export function parseGatewayCommand(rawInput: string): ParsedGatewayCommand {
  const raw = rawInput.trim();

  if (raw === "exit") {
    return {
      type: "exit",
      raw,
    };
  }

  if (raw === "help") {
    return {
      type: "help",
      raw,
    };
  }

  if (raw === "flush") {
    return {
      type: "flush",
      raw,
    };
  }

  if (raw === "recover") {
    return {
      type: "recover",
      raw,
    };
  }

  if (
    raw.startsWith("记住：") ||
    raw.startsWith("记住:") ||
    raw.startsWith("记住 ")
  ) {
    return {
      type: "remember",
      raw,
      payload: raw.replace(/^记住[:： ]*/, "").trim(),
    };
  }

  if (raw.startsWith("查记忆 ")) {
    return {
      type: "search-memory",
      raw,
      payload: raw.replace(/^查记忆 /, "").trim(),
    };
  }

  if (raw.startsWith("读文件 ")) {
    return {
      type: "read-file",
      raw,
      payload: raw.replace(/^读文件 /, "").trim(),
    };
  }

  if (raw === ":session" || raw.startsWith(":session ")) {
    return {
      type: "session",
      raw,
      payload: raw.replace(/^:session\s*/, "").trim(),
    };
  }

  if (raw === ":mcp" || raw.startsWith(":mcp ")) {
    return {
      type: "mcp",
      raw,
      payload: raw.replace(/^:mcp\s*/, "").trim(),
    };
  }

  if (raw === ":tools") {
    return {
      type: "tools",
      raw,
    };
  }

  if (raw === ":tool" || raw.startsWith(":tool ")) {
    return {
      type: "tool",
      raw,
      payload: raw.replace(/^:tool\s*/, "").trim(),
    };
  }

  return {
    type: "chat",
    raw,
    payload: raw,
  };
}
