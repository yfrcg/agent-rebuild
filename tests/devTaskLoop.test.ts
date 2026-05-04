import assert from "node:assert/strict";
import test from "node:test";

import {
  isDevTask,
  createDevTaskTracker,
  extractStructuredResult,
  trackToolCall,
  formatStructuredResultForContext,
  buildDevTaskSummaryPrompt,
  buildDevTaskSystemHint,
  serializeDevTaskTracker,
  deserializeDevTaskTracker,
} from "../packages/gateway/autoToolLoop";
import type { StructuredToolResult } from "../packages/gateway/autoToolLoop";
import { computeBackoffMs } from "../packages/gateway/agentRunner";
import { loadGatewayConfig } from "../packages/gateway/config";

test("isDevTask returns true for test-related requests", () => {
  assert.equal(isDevTask("fix the failing tests"), true);
  assert.equal(isDevTask("run npm test"), true);
  assert.equal(isDevTask("修复测试"), true);
  assert.equal(isDevTask("run typecheck"), true);
  assert.equal(isDevTask("implement a new feature"), true);
  assert.equal(isDevTask("refactor the module"), true);
  assert.equal(isDevTask("debug the issue"), true);
});

test("isDevTask returns false for non-dev requests", () => {
  assert.equal(isDevTask("what is the weather today"), false);
  assert.equal(isDevTask("tell me a joke"), false);
  assert.equal(isDevTask("hello"), false);
});

test("extractStructuredResult parses JSON command output", () => {
  const content = JSON.stringify({
    exitCode: 1,
    stdout: "FAIL tests/foo.test.ts",
    stderr: "Error: expected true got false",
    timedOut: false,
  });
  const result = extractStructuredResult("bash.run", { content, isError: true }, 1234);
  assert.equal(result.toolName, "bash.run");
  assert.equal(result.status, "error");
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdoutPreview, "FAIL tests/foo.test.ts");
  assert.equal(result.stderrPreview, "Error: expected true got false");
  assert.equal(result.timedOut, false);
  assert.equal(result.durationMs, 1234);
});

test("extractStructuredResult handles non-JSON content gracefully", () => {
  const result = extractStructuredResult("file.read", { content: "hello world" });
  assert.equal(result.toolName, "file.read");
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, undefined);
  assert.equal(result.rawContent, "hello world");
});

test("extractStructuredResult extracts fullOutputPath", () => {
  const content = JSON.stringify({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    fullOutputPath: "logs/tool-results/bash-run-123.log",
  });
  const result = extractStructuredResult("bash.run", { content });
  assert.equal(result.fullOutputPath, "logs/tool-results/bash-run-123.log");
});

test("formatStructuredResultForContext produces readable output", () => {
  const result: StructuredToolResult = {
    toolName: "bash.run",
    status: "error",
    exitCode: 1,
    stdoutPreview: "FAIL test.ts",
    stderrPreview: "TypeError at line 5",
    durationMs: 500,
    rawContent: "",
  };
  const formatted = formatStructuredResultForContext(result);
  assert.ok(formatted.includes("tool=bash.run"));
  assert.ok(formatted.includes("status=error"));
  assert.ok(formatted.includes("exitCode=1"));
  assert.ok(formatted.includes("FAIL test.ts"));
  assert.ok(formatted.includes("TypeError at line 5"));
  assert.ok(formatted.includes("durationMs=500"));
});

test("formatStructuredResultForContext handles minimal result", () => {
  const result: StructuredToolResult = {
    toolName: "file.read",
    status: "ok",
    rawContent: "file contents",
  };
  const formatted = formatStructuredResultForContext(result);
  assert.ok(formatted.includes("tool=file.read"));
  assert.ok(formatted.includes("status=ok"));
  assert.ok(!formatted.includes("exitCode"));
  assert.ok(!formatted.includes("stderr"));
});

test("createDevTaskTracker initializes empty tracker", () => {
  const tracker = createDevTaskTracker();
  assert.equal(tracker.filesModified.size, 0);
  assert.deepEqual(tracker.commandsRun, []);
  assert.deepEqual(tracker.testResults, []);
  assert.equal(tracker.fixRounds, 0);
});

test("trackToolCall records file modifications", () => {
  const tracker = createDevTaskTracker();
  const result: StructuredToolResult = {
    toolName: "file.edit",
    status: "ok",
    rawContent: "ok",
  };
  trackToolCall(tracker, "file.edit", { path: "src/foo.ts" }, result);
  assert.equal(tracker.filesModified.has("src/foo.ts"), true);
  assert.deepEqual(tracker.commandsRun, []);
});

test("trackToolCall records command execution and test results", () => {
  const tracker = createDevTaskTracker();
  const failResult: StructuredToolResult = {
    toolName: "powershell.run",
    status: "error",
    exitCode: 1,
    stderrPreview: "2 tests failed",
    rawContent: "",
  };
  trackToolCall(tracker, "powershell.run", { command: "pnpm test" }, failResult);
  assert.equal(tracker.commandsRun.length, 1);
  assert.equal(tracker.commandsRun[0].exitCode, 1);
  assert.equal(tracker.testResults.length, 1);
  assert.equal(tracker.testResults[0].passed, false);
  assert.equal(tracker.testResults[0].command, "pnpm test");
  assert.equal(tracker.fixRounds, 1);
});

test("trackToolCall marks passing tests correctly", () => {
  const tracker = createDevTaskTracker();
  const passResult: StructuredToolResult = {
    toolName: "bash.run",
    status: "ok",
    exitCode: 0,
    rawContent: "",
  };
  trackToolCall(tracker, "bash.run", { command: "npm run typecheck" }, passResult);
  assert.equal(tracker.testResults.length, 1);
  assert.equal(tracker.testResults[0].passed, true);
  assert.equal(tracker.fixRounds, 0);
});

test("trackToolCall does not track non-test commands as test results", () => {
  const tracker = createDevTaskTracker();
  const result: StructuredToolResult = {
    toolName: "bash.run",
    status: "ok",
    exitCode: 0,
    rawContent: "",
  };
  trackToolCall(tracker, "bash.run", { command: "ls -la" }, result);
  assert.equal(tracker.commandsRun.length, 1);
  assert.equal(tracker.testResults.length, 0);
});

test("buildDevTaskSummaryPrompt includes all tracked data", () => {
  const tracker = createDevTaskTracker();
  tracker.filesModified.add("src/foo.ts");
  tracker.filesModified.add("src/bar.ts");
  tracker.commandsRun.push({
    toolName: "bash.run",
    input: { command: "pnpm test" },
    exitCode: 1,
  });
  tracker.testResults.push({
    command: "pnpm test",
    passed: false,
    summary: "2 tests failed",
  });
  tracker.fixRounds = 1;

  const prompt = buildDevTaskSummaryPrompt(tracker);
  assert.ok(prompt.includes("[DEV_TASK_SUMMARY]"));
  assert.ok(prompt.includes("src/foo.ts"));
  assert.ok(prompt.includes("src/bar.ts"));
  assert.ok(prompt.includes("pnpm test"));
  assert.ok(prompt.includes("FAILED"));
  assert.ok(prompt.includes("Fix rounds used:"));
});

test("buildDevTaskSystemHint returns non-empty hint", () => {
  const hint = buildDevTaskSystemHint();
  assert.ok(hint.includes("[DEV_TASK_MODE]"));
  assert.ok(hint.includes("development task mode"));
  assert.ok(hint.includes("typecheck"));
});

test("extractStructuredResult truncates long stdout to 2000 chars", () => {
  const longStdout = "x".repeat(5000);
  const content = JSON.stringify({ exitCode: 0, stdout: longStdout, stderr: "" });
  const result = extractStructuredResult("bash.run", { content });
  assert.ok(result.stdoutPreview!.length < 5000);
  assert.equal(result.stdoutPreview!.length, 2000);
});

test("extractStructuredResult truncates long stderr to 1000 chars", () => {
  const longStderr = "e".repeat(3000);
  const content = JSON.stringify({ exitCode: 1, stdout: "", stderr: longStderr });
  const result = extractStructuredResult("bash.run", { content, isError: true });
  assert.ok(result.stderrPreview!.length < 3000);
  assert.equal(result.stderrPreview!.length, 1000);
});

test("trackToolCall handles missing path in file tools", () => {
  const tracker = createDevTaskTracker();
  const result: StructuredToolResult = {
    toolName: "file.edit",
    status: "ok",
    rawContent: "ok",
  };
  trackToolCall(tracker, "file.edit", {}, result);
  assert.equal(tracker.filesModified.size, 0);
});

test("buildDevTaskSummaryPrompt handles empty tracker", () => {
  const tracker = createDevTaskTracker();
  const prompt = buildDevTaskSummaryPrompt(tracker);
  assert.ok(prompt.includes("[DEV_TASK_SUMMARY]"));
  assert.ok(prompt.includes("(none)"));
});

test("trackToolCall detects pnpm run typecheck as test command", () => {
  const tracker = createDevTaskTracker();
  const result: StructuredToolResult = {
    toolName: "powershell.run",
    status: "error",
    exitCode: 2,
    stderrPreview: "Type error",
    rawContent: "",
  };
  trackToolCall(tracker, "powershell.run", { command: "pnpm run typecheck" }, result);
  assert.equal(tracker.testResults.length, 1);
  assert.equal(tracker.testResults[0].passed, false);
  assert.equal(tracker.testResults[0].command, "pnpm run typecheck");
});

test("trackToolCall detects npm run build as test command", () => {
  const tracker = createDevTaskTracker();
  const result: StructuredToolResult = {
    toolName: "bash.run",
    status: "ok",
    exitCode: 0,
    rawContent: "",
  };
  trackToolCall(tracker, "bash.run", { command: "npm run build" }, result);
  assert.equal(tracker.testResults.length, 1);
  assert.equal(tracker.testResults[0].passed, true);
});

test("serializeDevTaskTracker produces valid JSON", () => {
  const tracker = createDevTaskTracker();
  tracker.filesModified.add("src/foo.ts");
  tracker.commandsRun.push({ toolName: "bash.run", input: { command: "pnpm test" }, exitCode: 1 });
  tracker.testResults.push({ command: "pnpm test", passed: false, summary: "2 failed" });
  tracker.fixRounds = 2;

  const serialized = serializeDevTaskTracker(tracker);
  assert.ok(Array.isArray(serialized.filesModified));
  assert.equal(serialized.filesModified.length, 1);
  assert.equal(serialized.filesModified[0], "src/foo.ts");
  assert.equal(serialized.commandsRun.length, 1);
  assert.equal(serialized.testResults.length, 1);
  assert.equal(serialized.fixRounds, 2);
});

test("deserializeDevTaskTracker restores tracker from valid data", () => {
  const data = {
    filesModified: ["src/a.ts", "src/b.ts"],
    commandsRun: [{ toolName: "bash.run", input: { command: "pnpm test" }, exitCode: 0 }],
    testResults: [{ command: "pnpm test", passed: true, summary: "passed" }],
    fixRounds: 0,
  };
  const tracker = deserializeDevTaskTracker(data);
  assert.ok(tracker !== undefined);
  assert.equal(tracker!.filesModified.size, 2);
  assert.ok(tracker!.filesModified.has("src/a.ts"));
  assert.equal(tracker!.commandsRun.length, 1);
  assert.equal(tracker!.testResults.length, 1);
  assert.equal(tracker!.fixRounds, 0);
});

test("deserializeDevTaskTracker returns undefined for invalid data", () => {
  assert.equal(deserializeDevTaskTracker(null), undefined);
  assert.equal(deserializeDevTaskTracker(undefined), undefined);
  assert.equal(deserializeDevTaskTracker("string"), undefined);
  assert.equal(deserializeDevTaskTracker({ filesModified: "bad" }), undefined);
});

test("serialize/deserialize roundtrip preserves tracker state", () => {
  const original = createDevTaskTracker();
  original.filesModified.add("src/x.ts");
  original.filesModified.add("src/y.ts");
  original.commandsRun.push({ toolName: "powershell.run", input: { command: "pnpm test" }, exitCode: 1 });
  original.testResults.push({ command: "pnpm test", passed: false, summary: "failed" });
  original.fixRounds = 3;

  const serialized = serializeDevTaskTracker(original);
  const restored = deserializeDevTaskTracker(serialized);
  assert.ok(restored !== undefined);
  assert.deepEqual([...restored!.filesModified].sort(), ["src/x.ts", "src/y.ts"]);
  assert.equal(restored!.commandsRun.length, 1);
  assert.equal(restored!.testResults.length, 1);
  assert.equal(restored!.fixRounds, 3);
});

test("computeBackoffMs returns base for first fix round", () => {
  assert.equal(computeBackoffMs(1), 500);
});

test("computeBackoffMs doubles each round", () => {
  assert.equal(computeBackoffMs(1), 500);
  assert.equal(computeBackoffMs(2), 1000);
  assert.equal(computeBackoffMs(3), 2000);
  assert.equal(computeBackoffMs(4), 4000);
});

test("computeBackoffMs caps at 8000ms", () => {
  assert.equal(computeBackoffMs(5), 8000);
  assert.equal(computeBackoffMs(10), 8000);
  assert.equal(computeBackoffMs(100), 8000);
});

test("loadGatewayConfig includes devTaskMaxFixRounds with default", () => {
  const config = loadGatewayConfig();
  assert.equal(config.devTaskMaxFixRounds, 3);
});

test("loadGatewayConfig reads devTaskMaxFixRounds from env", () => {
  const config = loadGatewayConfig({ GATEWAY_DEV_TASK_MAX_FIX_ROUNDS: "5" });
  assert.equal(config.devTaskMaxFixRounds, 5);
});

test("loadGatewayConfig includes devTaskMaxSteps with default 15", () => {
  const config = loadGatewayConfig();
  assert.equal(config.devTaskMaxSteps, 15);
});

test("loadGatewayConfig reads devTaskMaxSteps from env", () => {
  const config = loadGatewayConfig({ GATEWAY_DEV_TASK_MAX_STEPS: "20" });
  assert.equal(config.devTaskMaxSteps, 20);
});

test("loadGatewayConfig falls back to default for invalid devTaskMaxSteps", () => {
  const config1 = loadGatewayConfig({ GATEWAY_DEV_TASK_MAX_STEPS: "abc" });
  assert.equal(config1.devTaskMaxSteps, 15);
  const config2 = loadGatewayConfig({ GATEWAY_DEV_TASK_MAX_STEPS: "-1" });
  assert.equal(config2.devTaskMaxSteps, 15);
  const config3 = loadGatewayConfig({ GATEWAY_DEV_TASK_MAX_STEPS: "0" });
  assert.equal(config3.devTaskMaxSteps, 15);
});

test("loadGatewayConfig falls back to default for invalid devTaskMaxFixRounds", () => {
  const config = loadGatewayConfig({ GATEWAY_DEV_TASK_MAX_FIX_ROUNDS: "xyz" });
  assert.equal(config.devTaskMaxFixRounds, 3);
});

test("GatewaySession can hold devTaskState", () => {
  const store = new (require("../packages/gateway/sessionStore").SessionStore)(
    require("node:path").join(require("node:os").tmpdir(), `test-session-${Date.now()}.json`)
  );
  const session = store.createSession({ name: "dev-task-test" });
  assert.equal(session.devTaskState, undefined);

  const updated = store.setDevTaskState(session.id, {
    isDevTask: true,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    filesTouched: ["src/foo.ts"],
    commandsRun: 3,
    testCommands: ["pnpm test"],
    fixRounds: 1,
    status: "running",
  });
  assert.ok(updated !== undefined);
  assert.equal(updated!.devTaskState!.isDevTask, true);
  assert.equal(updated!.devTaskState!.status, "running");
  assert.deepEqual(updated!.devTaskState!.filesTouched, ["src/foo.ts"]);
  assert.equal(updated!.devTaskState!.commandsRun, 3);
  assert.equal(updated!.devTaskState!.fixRounds, 1);
});

test("session devTaskState does not include raw stdout/stderr", () => {
  const store = new (require("../packages/gateway/sessionStore").SessionStore)(
    require("node:path").join(require("node:os").tmpdir(), `test-session-ss-${Date.now()}.json`)
  );
  const session = store.createSession({ name: "no-raw-output" });

  store.setDevTaskState(session.id, {
    isDevTask: true,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    filesTouched: ["src/bar.ts"],
    commandsRun: 2,
    testCommands: ["pnpm test"],
    lastFailureSummary: "2 tests failed in foo.test.ts",
    fixRounds: 1,
    status: "failed",
  });

  const reloaded = store.getSession(session.id);
  const serialized = JSON.stringify(reloaded!.devTaskState);
  assert.ok(!serialized.includes("stdout"), "should not contain raw stdout");
  assert.ok(!serialized.includes("stderr"), "should not contain raw stderr");
  assert.ok(serialized.includes("2 tests failed in foo.test.ts"), "should contain failure summary");
});

test("session devTaskState can be cleared", () => {
  const store = new (require("../packages/gateway/sessionStore").SessionStore)(
    require("node:path").join(require("node:os").tmpdir(), `test-session-clear-${Date.now()}.json`)
  );
  const session = store.createSession({ name: "clear-test" });

  store.setDevTaskState(session.id, {
    isDevTask: true,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    filesTouched: [],
    commandsRun: 1,
    testCommands: [],
    fixRounds: 0,
    status: "passed",
  });

  const cleared = store.setDevTaskState(session.id, undefined);
  assert.equal(cleared!.devTaskState, undefined);
});

test("session devTaskState persists across reload", () => {
  const tmpPath = require("node:path").join(
    require("node:os").tmpdir(),
    `test-session-persist-${Date.now()}.json`
  );
  const store1 = new (require("../packages/gateway/sessionStore").SessionStore)(tmpPath);
  const session = store1.createSession({ name: "persist-test" });

  store1.setDevTaskState(session.id, {
    isDevTask: true,
    startedAt: "2026-05-04T10:00:00Z",
    updatedAt: "2026-05-04T10:05:00Z",
    filesTouched: ["src/a.ts", "src/b.ts"],
    commandsRun: 5,
    testCommands: ["pnpm test", "pnpm run typecheck"],
    fixRounds: 2,
    status: "passed",
  });

  const store2 = new (require("../packages/gateway/sessionStore").SessionStore)(tmpPath);
  const reloaded = store2.getSession(session.id);
  assert.ok(reloaded !== undefined);
  assert.equal(reloaded!.devTaskState!.isDevTask, true);
  assert.equal(reloaded!.devTaskState!.status, "passed");
  assert.equal(reloaded!.devTaskState!.fixRounds, 2);
  assert.deepEqual(reloaded!.devTaskState!.filesTouched, ["src/a.ts", "src/b.ts"]);
});
