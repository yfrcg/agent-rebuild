
import assert from "node:assert/strict";
import test from "node:test";

import {
  createRealApiGateway,
  bypassRequest,
} from "./helpers/realApiTestHelper";

test("Gateway agent loop with real API: model responds with valid text", async () => {
  const { gateway, provider } = createRealApiGateway({ maxSteps: 5 });
  const request = bypassRequest("what is 2 + 2? answer in one word.", {
    sessionId: "session-auto-tool-real",
  });

  const response = await gateway.handle(request);
  provider.writeLog("auto-tool-loop-basic");

  console.log("\n=== Auto Tool Loop (Real API) ===");
  console.log("Text:", response.text.slice(0, 300));
  console.log("Tool calls:", response.toolCalls.length);
  console.log("finishReason:", response.debug?.autoToolLoop?.finishReason);
  console.log("API calls:", provider.getRecords().length);

  assert.ok(response.text.length > 0, "should have non-empty final text");
  assert.ok(response.debug?.autoToolLoop?.attempted, "auto tool loop should be attempted");
  assert.ok(provider.getRecords().length >= 1, "should have made >= 1 API call");
});

test("Gateway with real API: model runs shell command and reports result", async () => {
  const { gateway, provider } = createRealApiGateway({ maxSteps: 5 });
  const request = bypassRequest("run 'node -e \"console.log(42)\"' and tell me the output");

  const response = await gateway.handle(request);
  provider.writeLog("auto-tool-shell-run");

  console.log("\n=== Shell Run (Real API) ===");
  console.log("Text:", response.text.slice(0, 300));
  console.log("Tool calls:", response.toolCalls.length);
  for (const tc of response.toolCalls) {
    console.log(`  [${tc.toolName}] status=${tc.status} duration=${tc.durationMs}ms`);
  }

  assert.ok(response.text.length > 0, "should have non-empty text");
  assert.ok(response.toolCalls.length >= 1, "should have made >= 1 tool call");
  const anyShellSuccess = response.toolCalls.some(
    (tc) => tc.toolName === "shell.run" && tc.status === "success"
  );
  assert.ok(anyShellSuccess, "at least one shell.run should have succeeded");
});

test("Gateway with real API: model runs node version command", async () => {
  const { gateway, provider } = createRealApiGateway({ maxSteps: 5 });
  const request = bypassRequest("run 'node -v' and tell me the version number");

  const response = await gateway.handle(request);
  provider.writeLog("auto-tool-node-version");

  console.log("\n=== Node Version (Real API) ===");
  console.log("Text:", response.text.slice(0, 300));
  console.log("Tool calls:", response.toolCalls.length);
  for (const tc of response.toolCalls) {
    console.log(`  [${tc.toolName}] status=${tc.status} duration=${tc.durationMs}ms`);
  }

  assert.ok(response.text.length > 0, "should have non-empty text");
  assert.ok(response.toolCalls.length >= 1, "should have made >= 1 tool call");
  const anySuccess = response.toolCalls.some((tc) => tc.status === "success");
  assert.ok(anySuccess, "at least one tool call should have succeeded");
});

test("Gateway with real API: tool call results include timing metadata", async () => {
  const { gateway, provider } = createRealApiGateway({ maxSteps: 5 });
  const request = bypassRequest("run 'node -e \"console.log(1)\"' and report the output");

  const response = await gateway.handle(request);
  provider.writeLog("auto-tool-timing");

  assert.ok(response.toolCalls.length >= 1, "should have at least 1 tool call");
  for (const tc of response.toolCalls) {
    if (tc.status === "success") {
      assert.ok(
        tc.durationMs !== undefined && tc.durationMs > 0,
        `tool call ${tc.toolName} should have durationMs > 0, got ${tc.durationMs}`
      );
    }
  }

  assert.ok(
    response.debug?.autoToolLoop?.decisionTrace !== undefined,
    "should have decision trace"
  );
  assert.ok(
    response.debug?.autoToolLoop!.decisionTrace!.length >= 1,
    "trace should have >= 1 entries"
  );
});
