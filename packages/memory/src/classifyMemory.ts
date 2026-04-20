export type MemoryKind = "long-term" | "daily";//使用TS定义了一个名为MemoryKind的联合类型：限定记忆种类只能是这两个特定的字符串之一

//定义一个分类记忆的函数，接受一个字符串参数（通常是一句话或一段聊天记录），并承诺最终会返回上面定义的两种类型
export function classifyMemory(text: string): MemoryKind {
  //定义一个包含多个字符串的数组（长期提示词）：如果用户的对话中包含了这些词，说明用户正在传达一些相对永久的、关于个人的重要特征或指令
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
  //.some遍历上面的数组，只要有任何一个词在 text 中被找到了，.some() 就会立刻返回 true
  const shouldPromote = longTermHints.some((hint) => text.includes(hint));
  //如果对话有上面的长期关键词，就记录在长期记忆里面，否则当成普通对话
  return shouldPromote ? "long-term" : "daily";
}