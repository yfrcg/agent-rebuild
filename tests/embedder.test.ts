import test from "node:test";
import assert from "node:assert/strict";

import { embedText, getEmbedderKey, getEmbeddingProviderName } from "../packages/memory/src/embedder";

test("mock embedder is deterministic and uses configured dimensions", async () => {
  const previousProvider = process.env.EMBEDDING_PROVIDER;
  const previousDimensions = process.env.DASHSCOPE_EMBED_DIMENSIONS;

  process.env.EMBEDDING_PROVIDER = "mock";
  process.env.DASHSCOPE_EMBED_DIMENSIONS = "16";

  try {
    const first = await embedText("hello world");
    const second = await embedText("hello world");

    assert.equal(getEmbeddingProviderName(), "mock");
    assert.equal(getEmbedderKey(), "mock-16");
    assert.equal(first.length, 16);
    assert.deepEqual(first, second);
  } finally {
    if (previousProvider === undefined) {
      delete process.env.EMBEDDING_PROVIDER;
    } else {
      process.env.EMBEDDING_PROVIDER = previousProvider;
    }

    if (previousDimensions === undefined) {
      delete process.env.DASHSCOPE_EMBED_DIMENSIONS;
    } else {
      process.env.DASHSCOPE_EMBED_DIMENSIONS = previousDimensions;
    }
  }
});
