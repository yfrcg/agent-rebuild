import { readTranscript } from "./transcript";
import { writeDailyMemory, writeLongTermMemory } from "../../memory/src/memoryWriter";
import { loadBootstrapContext } from "../../core/src/bootstrap";

/*
这段代码解决的是所有 LLM（大语言模型）应用最终都会面临的终极物理限制问题：上下文窗口爆炸（Context Window Limit）。

当 AI 和你聊了几个小时，对话记录（Transcript）越来越长，
一旦超过大模型的最大 Token 限制，系统就会崩溃。
为了防止崩溃，系统必须进行**"上下文压缩（Compaction）**——把旧的聊天记录删掉或者浓缩。
*/

/**
 * 在上下文被压缩（清空/截断）之前，将最近的关键消息预先写入记忆系统。
 *
 * 该函数作为安全保护机制，在 transcript 被大规模丢弃前执行：
 * - 从 transcript 末尾取最近 12 条消息（最近的上下文窗口）
 * - 根据内容判断是否需要写入长期记忆（包含"记住/以后/长期"等关键词）
 * - 若无明确长期意图，则写入当日日志，作为历史日志保留
 *
 * 这一步确保即使上下文被清空，最重要的信息也不会永久丢失。
 *
 * @param sessionId - 会话唯一标识，对应 sessions/{sessionId}.jsonl
 * @returns 操作结果对象，包含：
 *   - ok: 是否成功（即使没有消息需要 flush，也会返回 ok=true）
 *   - message: 描述性说明（无消息时）
 *   - target: 写入目标（'MEMORY.md' | 'daily-memory'），无消息时不存在此字段
 */
export function preCompactionFlush(sessionId: string) {
  // 读取该会话的完整 transcript，取最近 12 条（对应最近约 12 轮对话）
  const transcript = readTranscript(sessionId);
  const recent = transcript.slice(-12);

  // 若 transcript 为空（从未发过消息），直接返回成功，无需任何操作
  if (recent.length === 0) {
    return { ok: true, message: "No transcript to flush." };
  }

  // 将最近消息合并为单字符串，格式与 compact.ts 一致：每条 "role: content"
  const merged = recent.map((x) => `${x.role}: ${x.content}`).join("\n");

  // 判断写入目标：若包含长期意图关键词则写 MEMORY.md，否则写当日日志
  if (merged.includes("记住") || merged.includes("以后") || merged.includes("长期")) {
    writeLongTermMemory(`Recovered from pre-compaction flush: ${merged.slice(0, 300)}`);
    return { ok: true, target: "MEMORY.md" };
  }

  writeDailyMemory(`Recovered from pre-compaction flush: ${merged.slice(0, 300)}`);
  return { ok: true, target: "daily-memory" };
}

/*
当上下文被无情地清空或压缩后，大模型其实处于一种"短暂的失忆"状态。
如果你不管它，它可能连自己是谁都忘了。

这个函数的作用就是**"重启系统并注入灵魂"**。
结合我们最开始看的第一张目录截图，loadBootstrapContext() 百分之百是去读取
SOUL.md（核心人设）、AGENTS.md（代理设定）和 TOOLS.md（工具列表）。
它把这些最根本的系统提示词（System Prompt）重新塞回给大模型，
确保 AI 在失忆后依然能保持正确的人设和能力边界。
*/

/**
 * 在上下文压缩完成后，恢复 AI 的核心人设与系统提示。
 *
 * 当 transcript 被大量截断后，AI 会丢失之前注入的角色设定、指令等信息。
 * 此函数通过 loadBootstrapContext() 重新加载并注入：
 *   - SOUL.md     → AI 的人格、性格、说话风格
 *   - AGENTS.md   → AI 的职责范围、工作流程规范
 *   - TOOLS.md    → 可用工具列表及其使用说明
 *   - USER.md     → 当前用户信息与偏好
 *   - memory/     → 长期记忆与近期日志
 *
 * 这使 AI 在"失忆"后能够重新"想起来"自己是谁、该做什么、如何做。
 *
 * @returns loadBootstrapContext() 的返回值，通常为包含BootstrapContext对象的Promise
 */
export function postCompactionRecovery() {
  // loadBootstrapContext 从文件系统加载所有核心配置文件，重新构建系统提示词
  return loadBootstrapContext();
}