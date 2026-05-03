/**
 * 记忆分类结果。
 *
 * - `long-term`：应该进入长期记忆，跨会话保留。
 * - `daily`：只记到当天日志型记忆中。
 */
export type MemoryKind = "long-term" | "daily";

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
