//启动文件模型：告诉系统，任何被当做“启动配置文件”读取进来的对象，都必须包含这四个属性。
export type BootstrapFile = {
  name: string;//文件名
  path: string;//绝对路径
  content: string;//读出来的文本内容
  missing: boolean;//标记这个文件是否存在
};
//启动上下文总包：这是 AI 每次醒来时收到的“开机大礼包”。它把所有读取好的系统设定（如 SOUL.md、TOOLS.md）打包在一个数组里，并附带了今天记忆文件的捷径路径，方便随时写入。
export type BootstrapContext = {
  bootstrapFiles: BootstrapFile[];
  todayMemoryPath: string;
};
//聊天记录
export type TranscriptEntry = {
  id: string;// 这条消息的唯一ID
  parentId?: string;// 父消息的ID（重点！）
  role: "system" | "user" | "assistant" | "tool";// 发送者的身份
  content: string;// 消息具体内容
  createdAt: string;// 发送时间
  metadata?: Record<string, unknown>;// 附加的元数据
};
//记忆搜索命中结果
export type SearchHit = {
  chunkId: string;// 记忆片段的ID
  filePath: string;// 这段记忆来自哪个文件
  section: string;// 属于哪个标题下
  content: string;// 记忆的具体内容
};