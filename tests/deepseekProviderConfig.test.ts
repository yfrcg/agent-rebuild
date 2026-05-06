
import assert from "node:assert/strict";
import test from "node:test";

import { DeepSeekProvider } from "../packages/model/deepseekProvider";

test("DeepSeekProvider bounds constructor numeric options", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  let aborted = false;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    const provider = new DeepSeekProvider({
      apiKey: "test-api-key",
      maxTokens: 0,
      temperature: 3,
      timeoutMs: 1,
    });

    const response = await provider.generate([{ role: "user", content: "hello" }]);

    assert.equal(response.text, "ok");
    assert.equal(requestBody?.max_tokens, 1024);
    assert.equal(requestBody?.temperature, 0.7);
    assert.equal(aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
