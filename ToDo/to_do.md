## 需要解决的问题
# 目前解决上下文爆炸的问题太过粗糙，详见packages/session/src/transcript.ts
# 目前写入向量库存在许多问题：详见

    writeDailyMemory()  →  写入 Markdown 文件
    rebuildMemoryIndex()  →  立刻重建索引（FTS + 向量）

    Gateway 里每次写入记忆后都紧接着调用了 rebuildMemoryIndex()（main.ts 第 108 行和第 144 行），所以索引是同步更新的，不存在时间差。

    不过我注意到第 144 行是"每句话都记"，然后立即重建索引——这个频率有点高，可能会影响性能。如果是生产级应用，可以考虑改成批量/定时重建。但目前项目阶段这样写没问题。
# 目前采用联合检索，权重设置感觉有点问题？