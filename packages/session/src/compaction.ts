import { readTranscript } from "./transcript";
import { writeDailyMemory, writeLongTermMemory } from "../../memory/src/memoryWriter";
import { loadBootstrapContext } from "../../core/src/bootstrap";
/*
这段代码解决的是所有 LLM（大语言模型）应用最终都会面临的终极物理限制问题：上下文窗口爆炸（Context Window Limit）。

当 AI 和你聊了几个小时，对话记录（Transcript）越来越长，
一旦超过大模型的最大 Token 限制，系统就会崩溃。
为了防止崩溃，系统必须进行**“上下文压缩（Compaction）”**——把旧的聊天记录删掉或者浓缩。
*/
//当系统发现对话太长，准备清空当前上下文时，这个函数会被触发。它的任务是：在记忆被抹除前，把最重要的东西抄在笔记本上。
export function preCompactionFlush(sessionId: string) {
  const transcript = readTranscript(sessionId);
  const recent = transcript.slice(-12);

  if (recent.length === 0) {
    return { ok: true, message: "No transcript to flush." };
  }

  const merged = recent.map((x) => `${x.role}: ${x.content}`).join("\n");

  if (merged.includes("记住") || merged.includes("以后") || merged.includes("长期")) {
    writeLongTermMemory(`Recovered from pre-compaction flush: ${merged.slice(0, 300)}`);
    return { ok: true, target: "MEMORY.md" };
  }

  writeDailyMemory(`Recovered from pre-compaction flush: ${merged.slice(0, 300)}`);
  return { ok: true, target: "daily-memory" };
}

/*
当上下文被无情地清空或压缩后，大模型其实处于一种“短暂的失忆”状态。如果你不管它，它可能连自己是谁都忘了。
这个函数的作用就是**“重启系统并注入灵魂”。
结合我们最开始看的第一张目录截图，loadBootstrapContext() 百分之百是去读取 SOUL.md（核心人设）、AGENTS.md（代理设定）和 TOOLS.md（工具列表）。
它把这些最根本的系统提示词（System Prompt）**重新塞回给大模型，确保 AI 在失忆后依然能保持正确的人设和能力边界。
*/
export function postCompactionRecovery() {
  return loadBootstrapContext();
}