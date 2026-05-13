import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createRealApiGateway, bypassRequest, shouldRunRealApiTests } from "./helpers/realApiTestHelper";

const describeLive = shouldRunRealApiTests() ? describe : describe.skip;

describeLive("auto tool loop", () => {
  test("model responds with valid text", async () => {
    const { gateway, provider } = createRealApiGateway({ maxSteps: 5 });
    const request = bypassRequest("what is 2 + 2? answer in one word.", { sessionId: "session-auto-tool-real" });
    const response = await gateway.handle(request);
    provider.writeLog("auto-tool-loop-basic");
    assert.ok(response.text.length > 0, "should have non-empty final text");
    assert.ok(response.debug?.autoToolLoop?.attempted, "auto tool loop should be attempted");
    assert.ok(provider.getRecords().length >= 1, "should have made >= 1 API call");
  });

  test("model runs shell command and reports result", async () => {
    const { gateway, provider } = createRealApiGateway({ maxSteps: 5 });
    const request = bypassRequest("run 'node -e \"console.log(42)\"' and tell me the output");
    const response = await gateway.handle(request);
    provider.writeLog("auto-tool-shell-run");
    assert.ok(response.text.length > 0, "should have non-empty text");
    assert.ok(response.toolCalls.length >= 1, "should have made >= 1 tool call");
    const anyShellSuccess = response.toolCalls.some((tc) => tc.toolName === "shell.run" && tc.status === "success");
    assert.ok(anyShellSuccess, "at least one shell.run should have succeeded");
  });

  test("model runs node version command", async () => {
    const { gateway, provider } = createRealApiGateway({ maxSteps: 5 });
    const request = bypassRequest("run 'node -v' and tell me the version number");
    const response = await gateway.handle(request);
    provider.writeLog("auto-tool-node-version");
    assert.ok(response.text.length > 0, "should have non-empty text");
    assert.ok(response.toolCalls.length >= 1, "should have made >= 1 tool call");
    const anySuccess = response.toolCalls.some((tc) => tc.status === "success");
    assert.ok(anySuccess, "at least one tool call should have succeeded");
  });

  test("tool call results include timing metadata", async () => {
    const { gateway, provider } = createRealApiGateway({ maxSteps: 5 });
    const request = bypassRequest("run 'node -e \"console.log(1)\"' and report the output");
    const response = await gateway.handle(request);
    provider.writeLog("auto-tool-timing");
    assert.ok(response.toolCalls.length >= 1, "should have at least 1 tool call");
    for (const tc of response.toolCalls) {
      if (tc.status === "success") {
        assert.ok(tc.durationMs !== undefined && tc.durationMs > 0, `tool call ${tc.toolName} should have durationMs > 0`);
      }
    }
    assert.ok(response.debug?.autoToolLoop?.decisionTrace !== undefined, "should have decision trace");
    assert.ok(response.debug?.autoToolLoop!.decisionTrace!.length >= 1, "trace should have >= 1 entries");
  });
});
