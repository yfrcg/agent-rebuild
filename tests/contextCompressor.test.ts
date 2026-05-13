
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { ContextCompressor } from "../packages/gateway/contextCompressor";
import type { ChatMessage } from "../packages/model/types";

/**
 * 函数 `makeToolResultMsg` 的职责说明。
 * `makeToolResultMsg` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function makeToolResultMsg(toolName: string, filePath?: string, size = 500): ChatMessage {
  const pathPart = filePath ? ` path: ${filePath}` : "";
  return {
    role: "user",
    content: `[AUTO_TOOL_RESULTS]\ntool: ${toolName}${pathPart}\n` + "x".repeat(size),
  };
}

/**
 * 函数 `makeMsgs` 的职责说明。
 * `makeMsgs` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function makeMsgs(toolResults: Array<{ name: string; path?: string; size?: number }>): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
  ];
  for (const tr of toolResults) {
    msgs.push(makeToolResultMsg(tr.name, tr.path, tr.size));
    msgs.push({ role: "assistant", content: `I read ${tr.name}` });
  }
  return msgs;
}

test("ContextCompressor runPipeline returns zero stats when utilization is low", () => {
  const compressor = new ContextCompressor({ maxContextTokens: 100_000 });
  compressor.updateTokenEstimate(10_000);

  const messages = makeMsgs([
    { name: "file.read", path: "/tmp/a.txt", size: 500 },
  ]);

  const stats = compressor.runPipeline(messages);

  assert.equal(stats.tier1Budget, 0);
  assert.equal(stats.tier2Snip, 0);
  assert.equal(stats.tier3Microcompact, 0);
  assert.ok(stats.totalCharsAfter > 0);
});

test("ContextCompressor Tier 1 budget-truncates large tool results above threshold", () => {
  const compressor = new ContextCompressor({ maxContextTokens: 100_000 });
  compressor.updateTokenEstimate(60_000);

  const bigResult = "x".repeat(50_000);
  const messages: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "q" },
    { role: "user", content: `[AUTO_TOOL_RESULTS]\ntool: file.read\n${bigResult}` },
  ];

  const stats = compressor.runPipeline(messages);

  assert.equal(stats.tier1Budget, 1);
  assert.ok(messages[2].content.length < bigResult.length + 200);
  assert.ok(messages[2].content.includes("budgeted"));
});

test("ContextCompressor Tier 2 snips stale duplicate file reads", () => {
  const compressor = new ContextCompressor({ maxContextTokens: 100_000 });
  compressor.updateTokenEstimate(70_000);

  const messages = makeMsgs([
    { name: "file.read", path: "/tmp/same.txt", size: 800 },
    { name: "file.read", path: "/tmp/same.txt", size: 800 },
    { name: "file.read", path: "/tmp/same.txt", size: 800 },
    { name: "file.read", path: "/tmp/other1.txt", size: 800 },
    { name: "file.read", path: "/tmp/other2.txt", size: 800 },
    { name: "file.read", path: "/tmp/other3.txt", size: 800 },
  ]);

  const stats = compressor.runPipeline(messages);

  assert.ok(stats.tier2Snip >= 1, `Expected tier2Snip >= 1, got ${stats.tier2Snip}`);
});

test("ContextCompressor Tier 3 microcompact clears old results after idle", () => {
  const compressor = new ContextCompressor({ maxContextTokens: 100_000 });
  compressor.updateTokenEstimate(50_000);

  const messages = makeMsgs([
    { name: "file.read", path: "/a.txt", size: 500 },
    { name: "file.read", path: "/b.txt", size: 500 },
    { name: "file.read", path: "/c.txt", size: 500 },
    { name: "file.read", path: "/d.txt", size: 500 },
    { name: "file.read", path: "/e.txt", size: 500 },
  ]);

  (compressor as any).lastApiCallTime = Date.now() - 16 * 60 * 1000;

  const stats = compressor.runPipeline(messages);

  assert.ok(stats.tier3Microcompact >= 1, `Expected tier3Microcompact >= 1, got ${stats.tier3Microcompact}`);
});

test("ContextCompressor needsAutoCompact returns true when utilization exceeds 85%", () => {
  const compressor = new ContextCompressor({ maxContextTokens: 100_000 });
  compressor.updateTokenEstimate(86_000);

  const messages = makeMsgs([
    { name: "file.read", path: "/a.txt" },
    { name: "file.read", path: "/b.txt" },
    { name: "file.read", path: "/c.txt" },
    { name: "file.read", path: "/d.txt" },
    { name: "file.read", path: "/e.txt" },
  ]);

  assert.equal(compressor.needsAutoCompact(messages), true);
});

test("ContextCompressor needsAutoCompact returns false when utilization is below 85%", () => {
  const compressor = new ContextCompressor({ maxContextTokens: 100_000 });
  compressor.updateTokenEstimate(50_000);

  const messages = makeMsgs([{ name: "file.read", path: "/a.txt" }]);

  assert.equal(compressor.needsAutoCompact(messages), false);
});

test("ContextCompressor persistLargeResult writes to disk and returns preview", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
  const compressor = new ContextCompressor({ toolResultDir: tmpDir });

  const largeContent = "a".repeat(40_000);
  const result = compressor.persistLargeResult("file.read", largeContent);

  assert.ok(result.includes("Result too large"), `Expected "Result too large" in result`);
  assert.ok(result.includes("Preview"));

  const files = fs.readdirSync(tmpDir);
  assert.equal(files.length, 1, `Expected 1 file, got ${files.length}`);
  assert.ok(files[0].endsWith(".txt"));

  fs.rmSync(tmpDir, { recursive: true });
});

test("ContextCompressor persistLargeResult returns original for small results", () => {
  const compressor = new ContextCompressor();
  const smallContent = "hello world";
  const result = compressor.persistLargeResult("file.read", smallContent);

  assert.equal(result, smallContent);
});

test("ContextCompressor autoCompact replaces history with summary", async () => {
  const compressor = new ContextCompressor({ maxContextTokens: 100_000 });
  compressor.updateTokenEstimate(90_000);

  const messages: ChatMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "question 1" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "question 2" },
    { role: "assistant", content: "answer 2" },
  ];

  const result = await compressor.autoCompact(messages, async () => "summary of conversation");

  assert.equal(result, true);
  assert.ok(messages.some((m) => m.content.includes("auto-compacted")));
  assert.ok(messages.some((m) => m.content.includes("summary of conversation")));
});

test("ContextCompressor autoCompact returns false when utilization is low", async () => {
  const compressor = new ContextCompressor({ maxContextTokens: 100_000 });
  compressor.updateTokenEstimate(50_000);

  const messages: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
  ];

  const result = await compressor.autoCompact(messages, async () => "summary");
  assert.equal(result, false);
});

test("ContextCompressor handles empty messages array gracefully", () => {
  const compressor = new ContextCompressor();
  compressor.updateTokenEstimate(0);

  const stats = compressor.runPipeline([]);

  assert.equal(stats.tier1Budget, 0);
  assert.equal(stats.tier2Snip, 0);
  assert.equal(stats.tier3Microcompact, 0);
  assert.equal(stats.totalCharsBefore, 0);
  assert.equal(stats.totalCharsAfter, 0);
});
