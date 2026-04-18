export type MemoryKind = "long-term" | "daily";

export function classifyMemory(text: string): MemoryKind {
  const longTermHints = [
    "记住",
    "以后",
    "长期",
    "总是",
    "偏好",
    "习惯",
    "固定决策",
  ];

  const shouldPromote = longTermHints.some((hint) => text.includes(hint));
  return shouldPromote ? "long-term" : "daily";
}