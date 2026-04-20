import { backfillEmbeddings } from "../packages/memory/src/backfillEmbeddings";

async function main() {
  const result = await backfillEmbeddings();
  console.log("Embeddings backfilled.", result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});