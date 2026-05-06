
import { rebuildMemoryIndex } from "../packages/memory/src/memoryIndex";

/**
 * 执行一次全量记忆索引重建。
 *
 * 会清空现有索引表，再重新扫描全部记忆文件进行构建。
 */
rebuildMemoryIndex();
console.log("Memory index rebuilt.");
