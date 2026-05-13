/**
 * ?????CS336 ???
 * ???tests/gateway.test.ts
 * ????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { sanitizeFallbackText } from "../packages/gateway/gateway";
import { loadGatewayConfig } from "../packages/gateway/config";
import { TokenPlanProvider } from "../packages/model/tokenPlanProvider";
import { embedText, getEmbedderKey, getEmbeddingProviderName } from "../packages/memory/src/embedder";

describe("gateway fallback sanitize", () => {
  test("removes tool-call residue from plain-text fallback", () => {
    const raw = `
[⚠ 工具未被调用 — 模型未按 JSON 格式返回工具调用]
[TOOL_CALL] {"type":"tool_call","tool":"shell.run","args":{"command":"type D:\\\\WorkStation\\\\CoLab\\\\yanghui.cpp","cwd":"D:\\\\WorkStation\\\\CoLab"}}
[TOOL_CALL] {"type":"tool_call","tool":"shell.run","args":{"command":"g++ -o yanghui.exe yanghui.cpp && yanghui.exe","cwd":"D:\\\\WorkStation\\\\CoLab"}}
`;
    assert.equal(sanitizeFallbackText(raw), "");
  });

  test("prefers final content when final JSON is present", () => {
    const raw = `
[TOOL_CALL] {"type":"tool_call","tool":"file.write","args":{"path":"hello.cpp","content":"#include <iostream>\\n"}}
{"type":"final","content":"已创建 hello.cpp"}
`;
    assert.equal(sanitizeFallbackText(raw), "已创建 hello.cpp");
  });

  test("strips tool result blocks", () => {
    const raw = `
[Tool Result] tool=shell.run
args={"command":"dir yanghui.cpp","cwd":"D:\\\\WorkStation\\\\CoLab"}
[/Tool Result]
`;
    assert.equal(sanitizeFallbackText(raw), "");
  });
});

describe("gateway config", () => {
  test("defaults to MiniMax TokenPlan when GATEWAY_MODEL is unset", () => {
    const config = loadGatewayConfig({} as NodeJS.ProcessEnv);
    assert.equal(config.model, "tokenplan");
  });

  test("supports mock model, sandbox mode, and session auto compaction settings", () => {
    const config = loadGatewayConfig({
      GATEWAY_MODEL: "mock", GATEWAY_MEMORY_TOP_K: "7",
      GATEWAY_SANDBOX_MODE: "read-only", GATEWAY_SANDBOX_ALLOWED_ROOTS: "workspace,config",
      GATEWAY_CONFIRM_TOKEN_TTL_MS: "90000",
      GATEWAY_SESSION_AUTO_COMPACT_ENABLED: "false", GATEWAY_SESSION_AUTO_COMPACT_MAX_ENTRIES: "42",
    } as NodeJS.ProcessEnv);
    assert.equal(config.model, "mock");
    assert.equal(config.memoryTopK, 7);
    assert.equal(config.sandboxMode, "read-only");
    assert.equal(config.confirmTokenTtlMs, 90000);
    assert.equal(config.sessionAutoCompactEnabled, false);
    assert.equal(config.sessionAutoCompactMaxEntries, 42);
  });

  test("supports MiniMax TokenPlan model aliases", () => {
    const tokenPlan = loadGatewayConfig({ GATEWAY_MODEL: "tokenplan" } as NodeJS.ProcessEnv);
    const miniMax = loadGatewayConfig({ GATEWAY_MODEL: "minimax" } as NodeJS.ProcessEnv);
    assert.equal(tokenPlan.model, "tokenplan");
    assert.equal(miniMax.model, "tokenplan");
  });
});

describe("tokenplan provider config", () => {
  test("bounds constructor numeric options", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    let aborted = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      init?.signal?.addEventListener("abort", () => { aborted = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const provider = new TokenPlanProvider({ apiKey: "test-api-key", maxTokens: 0, temperature: 3, timeoutMs: 1 });
      const response = await provider.generate([{ role: "user", content: "hello" }]);
      assert.equal(response.text, "ok");
      assert.equal(requestBody?.max_tokens, 1024);
      assert.equal(requestBody?.temperature, 0.7);
      assert.equal(aborted, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("embedder", () => {
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
      if (previousProvider === undefined) { delete process.env.EMBEDDING_PROVIDER; } else { process.env.EMBEDDING_PROVIDER = previousProvider; }
      if (previousDimensions === undefined) { delete process.env.DASHSCOPE_EMBED_DIMENSIONS; } else { process.env.DASHSCOPE_EMBED_DIMENSIONS = previousDimensions; }
    }
  });
});
