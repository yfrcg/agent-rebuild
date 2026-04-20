import { getAllEmbeddingRecords, saveEmbedding } from "./embeddingStore";
import { embedText } from "./embedder";

/*
在实际的 AI Agent 运行中，这个 backfill（回填）函数通常用于以下几种场景：

系统冷启动/数据迁移：假设你原本只用普通文本记录 AI 的日志（比如直接写 Markdown），现在你想给 AI 升级加上向量检索功能。
你可以把所有的历史 Markdown 文件切块存入，然后运行这个函数，它就会自动把所有历史文本一次性翻译成向量。

API 故障恢复：如果 AI 在日常运行中，网络突然中断或 API 达到限流（Rate Limit），导致一段记忆只存了文本没来得及生成向量。
这个脚本可以作为后台的“定时清理任务”，把那些遗漏的记忆重新补上向量。
*/
export async function backfillEmbeddings() {
  const records = getAllEmbeddingRecords();//从数据库或本地存储中，获取所有的记忆记录

  let updated = 0;//计数器：记录本次操作一共成功转化了多少条新记忆

  //每次调用embedText都是消耗Token和时间的，拦截掉冗余操作节省时间和Token
  for (const record of records) {
    if (record.embedding && record.embedding.length > 0) {
      continue;
    }

    const embedding = await embedText(record.content);//将这条纯文本内容发给Embedding模型，等待返回一个向量数组
    saveEmbedding(record.chunkId, embedding);//将原始记忆块ID和向量数组绑定，存回数据库中
    updated += 1;//计数加一
  }

  return {
    total: records.length,
    updated,
  };
}