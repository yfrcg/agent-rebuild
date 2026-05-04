import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { StreamProcessor } from "../packages/gateway/streamProcessor";

test("StreamProcessor accumulates text chunks and returns full text", () => {
  const processor = new StreamProcessor();

  processor.processTextChunk("Hello ");
  processor.processTextChunk("world ");
  processor.processTextChunk("!");

  assert.equal(processor.getFullText(), "Hello world !");
  assert.equal(processor.getBuffer(), "Hello world !");
});

test("StreamProcessor clearBuffer resets buffer but keeps fullText", () => {
  const processor = new StreamProcessor();

  processor.processTextChunk("Hello world");
  processor.clearBuffer();

  assert.equal(processor.getBuffer(), "");
  assert.equal(processor.getFullText(), "Hello world");
});

test("StreamProcessor reset clears both buffer and fullText", () => {
  const processor = new StreamProcessor();

  processor.processTextChunk("Hello world");
  processor.reset();

  assert.equal(processor.getBuffer(), "");
  assert.equal(processor.getFullText(), "");
});

test("StreamProcessor finalize returns full text and resets", () => {
  const processor = new StreamProcessor();

  processor.processTextChunk("Hello ");
  processor.processTextChunk("world");

  const result = processor.finalize();

  assert.equal(result, "Hello world");
  assert.equal(processor.getFullText(), "");
});

test("StreamProcessor onTextDelta callback receives each chunk", () => {
  const chunks: string[] = [];
  const processor = new StreamProcessor({
    onTextDelta: (text) => chunks.push(text),
  });

  processor.processTextChunk("a");
  processor.processTextChunk("b");
  processor.processTextChunk("c");

  assert.deepEqual(chunks, ["a", "b", "c"]);
});

test("StreamProcessor emitChunk dispatches to correct handlers", () => {
  const events: string[] = [];
  const processor = new StreamProcessor({
    onTextDelta: (text) => events.push(`text:${text}`),
    onToolStart: (name, args) => events.push(`tool_start:${name}`),
    onToolEnd: (name, result) => events.push(`tool_end:${name}`),
    onError: (err) => events.push(`error:${err}`),
    onDone: () => events.push("done"),
  });

  processor.emitChunk({ type: "text_delta", content: "hello" });
  processor.emitChunk({ type: "tool_start", toolName: "file.read", toolArgs: { path: "/a.txt" } });
  processor.emitChunk({ type: "tool_end", toolName: "file.read", toolResult: "content" });
  processor.emitChunk({ type: "error", error: "something failed" });
  processor.emitChunk({ type: "done" });

  assert.deepEqual(events, [
    "text:hello",
    "tool_start:file.read",
    "tool_end:file.read",
    "error:something failed",
    "done",
  ]);
});

test("StreamProcessor collectChunks aggregates text and tool calls", () => {
  const processor = new StreamProcessor();

  const result = processor.collectChunks([
    { type: "text_delta", content: "Thinking..." },
    { type: "tool_start", toolName: "file.read", toolArgs: { path: "/test.txt" } },
    { type: "tool_end", toolName: "file.read", toolResult: "file content" },
    { type: "text_delta", content: " Done." },
  ]);

  assert.equal(result.text, "Thinking... Done.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "file.read");
  assert.equal(result.toolCalls[0].result, "file content");
});

test("StreamProcessor persistLargeResult writes to disk for large content", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-test-"));
  const processor = new StreamProcessor({ toolResultDir: tmpDir });

  const largeContent = "data line\n".repeat(5000);
  const result = processor.persistLargeResult("shell.exec", largeContent);

  assert.ok(result.includes("Result too large"));
  assert.ok(result.includes("Preview"));

  const files = fs.readdirSync(tmpDir);
  assert.equal(files.length, 1);

  fs.rmSync(tmpDir, { recursive: true });
});

test("StreamProcessor persistLargeResult returns original for small content", () => {
  const processor = new StreamProcessor();
  const smallContent = "small output";

  const result = processor.persistLargeResult("shell.exec", smallContent);
  assert.equal(result, smallContent);
});

test("StreamProcessor truncateGlobally truncates text exceeding threshold", () => {
  const processor = new StreamProcessor();

  const longText = "a".repeat(30_000);
  const result = processor.truncateGlobally(longText);

  assert.ok(result.length < longText.length);
  assert.ok(result.startsWith("a".repeat(10_000)));
  assert.ok(result.includes("truncated"));
});

test("StreamProcessor truncateGlobally returns original for short text", () => {
  const processor = new StreamProcessor();

  const shortText = "hello world";
  const result = processor.truncateGlobally(shortText);

  assert.equal(result, shortText);
});

test("StreamProcessor handles empty input gracefully", () => {
  const processor = new StreamProcessor();

  assert.equal(processor.getFullText(), "");
  assert.equal(processor.getBuffer(), "");

  const result = processor.finalize();
  assert.equal(result, "");
});

test("StreamProcessor default handlers do not throw", () => {
  const processor = new StreamProcessor();

  assert.doesNotThrow(() => {
    processor.emitChunk({ type: "text_delta", content: "test" });
    processor.emitChunk({ type: "tool_start", toolName: "x" });
    processor.emitChunk({ type: "tool_end", toolName: "x", toolResult: "r" });
    processor.emitChunk({ type: "error", error: "e" });
    processor.emitChunk({ type: "done" });
  });
});
