
import { backfillEmbeddings } from "../packages/memory/src/backfillEmbeddings";

/**
 * 手动触发一次 embedding 回填。
 *
 * 这个脚本适合在开发或排障时单独执行，
 * 观察当前待处理向量是否能被顺利补齐。
 */
async function main() {
  const result = await backfillEmbeddings();
  console.log("Embeddings backfilled.", result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
