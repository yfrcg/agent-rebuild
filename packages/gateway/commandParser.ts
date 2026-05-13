/**
 * ?????CS336 ???
 * ???packages/gateway/commandParser.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */

export type GatewayCommandType =
  | "exit"
  | "help"
  | "flush"
  | "recover"
  | "compact"
  | "remember"
  | "search-memory"
  | "read-file"
  | "session"
  | "new-chat"
  | "new-session"
  | "bind"
  | "mcp"
  | "skills"
  | "plan"
  | "approvals"
  | "confirm"
  | "reject"
  | "tools"
  | "tool"
  | "sandbox"
  | "sh"
  | "chat";

/**
 * 统一的命令解析结果。
 *
 * `raw` 保留原始输入，`type` 给出路由目标，
 * `payload` 则承载命令真正的业务参数。
 */
export interface ParsedGatewayCommand {
  type: GatewayCommandType;
  raw: string;
  payload?: string;
}

/**
 * 把一行原始输入解析为 Gateway 内部命令。
 *
 * 解析顺序遵循“精确命令优先，前缀命令其次，剩余全部当普通聊天”的原则，
 * 从而让 REPL 层能在非常早的阶段完成路由分流。
 */
export function parseGatewayCommand(rawInput: string): ParsedGatewayCommand {
  const raw = rawInput.trim();

  // 先处理无需参数的精确命令。
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

  if (raw === "compact") {
    return {
      type: "compact",
      raw,
    };
  }

  // 再处理带载荷的自然语言命令。
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

  if (raw.startsWith("查记忆")) {
    return {
      type: "search-memory",
      raw,
      payload: raw.replace(/^查记忆\s*/, "").trim(),
    };
  }

  if (raw.startsWith("读文件")) {
    return {
      type: "read-file",
      raw,
      payload: raw.replace(/^读文件\s*/, "").trim(),
    };
  }

  if (raw.toLowerCase().startsWith("use skill ")) {
    return {
      type: "skills",
      raw,
      payload: `use ${raw.slice("use skill ".length).trim()}`,
    };
  }

  if (raw.startsWith("/") && raw.length > 1 && !raw.startsWith("//")) {
    const slashBody = raw.slice(1).trim();
    const spaceIdx = slashBody.indexOf(" ");
    const skillName = spaceIdx === -1 ? slashBody : slashBody.slice(0, spaceIdx);
    const skillArgs = spaceIdx === -1 ? "" : slashBody.slice(spaceIdx + 1).trim();

    if (skillName && /^[a-zA-Z0-9._/-]+$/.test(skillName)) {
      return {
        type: "skills",
        raw,
        payload: `invoke ${skillName}${skillArgs ? ` ${skillArgs}` : ""}`,
      };
    }
  }

  // 以下是以冒号开头的运维型命令。
  if (raw === ":session" || raw.startsWith(":session ")) {
    return {
      type: "session",
      raw,
      payload: raw.replace(/^:session\s*/, "").trim(),
    };
  }

  if (raw === ":new-chat" || raw.startsWith(":new-chat ")) {
    return {
      type: "new-chat",
      raw,
      payload: raw.replace(/^:new-chat\s*/, "").trim(),
    };
  }

  if (raw === ":bind" || raw.startsWith(":bind ")) {
    return {
      type: "bind",
      raw,
      payload: raw.replace(/^:bind\s*/, "").trim(),
    };
  }

  if (raw.startsWith(":new ") || raw === ":new") {
    return {
      type: "new-session",
      raw,
      payload: raw.replace(/^:new\s*/, "").trim(),
    };
  }

  if (raw === ":mcp" || raw.startsWith(":mcp ")) {
    return {
      type: "mcp",
      raw,
      payload: raw.replace(/^:mcp\s*/, "").trim(),
    };
  }

  if (raw === ":skills" || raw.startsWith(":skills ")) {
    return {
      type: "skills",
      raw,
      payload: raw.replace(/^:skills\s*/, "").trim(),
    };
  }

  if (raw === ":plan" || raw.startsWith(":plan ")) {
    return {
      type: "plan",
      raw,
      payload: raw.replace(/^:plan\s*/, "").trim(),
    };
  }

  if (raw === ":approvals" || raw.startsWith(":approvals ")) {
    return {
      type: "approvals",
      raw,
      payload: raw.replace(/^:approvals\s*/, "").trim(),
    };
  }

  if (raw === ":confirm" || raw.startsWith(":confirm ")) {
    return {
      type: "confirm",
      raw,
      payload: raw.replace(/^:confirm\s*/, "").trim(),
    };
  }

  if (raw === ":reject" || raw.startsWith(":reject ")) {
    return {
      type: "reject",
      raw,
      payload: raw.replace(/^:reject\s*/, "").trim(),
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

  if (raw === ":sandbox" || raw.startsWith(":sandbox ")) {
    return {
      type: "sh",
      raw,
      payload: raw.replace(/^:sandbox\s*/, "").trim(),
    };
  }

  if (raw === ":sh" || raw.startsWith(":sh ")) {
    return {
      type: "sh",
      raw,
      payload: raw.replace(/^:sh\s*/, "").trim(),
    };
  }

  // 未命中任何命令时，默认作为普通对话请求下发给 Gateway。
  return {
    type: "chat",
    raw,
    payload: raw,
  };
}
