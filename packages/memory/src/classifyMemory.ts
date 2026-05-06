
export type MemoryKind = "long-term" | "daily";
export type MemoryCategory = "user" | "feedback" | "project" | "reference";

/**
 * 根据文本内容判断这条信息更适合进入哪一类记忆。
 *
 * 当前策略是关键字启发式：
 * 如果文本里包含“记住、以后、长期、偏好、身份信息”等强长期信号，
 * 就提升为长期记忆；否则默认记到 daily memory。
 */
export function classifyMemory(text: string): MemoryKind {
  const longTermHints = [
    "记住",
    "以后",
    "长期",
    "总是",
    "偏好",
    "习惯",
    "固定决策",
    "我的名字",
    "我是",
    "每次都",
    "从来都",
    "请务必",
    "绝对不要",
    "一定不能",
    "不要改变",
    "不要改",
  ];

  const shouldPromote = longTermHints.some((hint) => text.includes(hint));
  return shouldPromote ? "long-term" : "daily";
}

/**
 * 函数 `classifyMemoryType` 的职责说明。
 * `classifyMemoryType` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function classifyMemoryType(text: string): MemoryCategory {
  const normalized = text.trim().toLowerCase();

  if (
    /以后|从现在开始|偏好|习惯|请务必|不要|总是|never|always|prefer/.test(text) ||
    /\b(prefer|always|never|avoid)\b/.test(normalized)
  ) {
    return "user";
  }

  if (
    /你刚才|你应该|请改|纠正|以后不要|反馈|bug in your behavior/.test(text) ||
    /\b(feedback|correction|wrong|should have)\b/.test(normalized)
  ) {
    return "feedback";
  }

  if (
    /路径|文档|链接|入口|readme|wiki|url|http/.test(text) ||
    /\b(path|document|docs|reference|link|url)\b/.test(normalized)
  ) {
    return "reference";
  }

  return "project";
}
