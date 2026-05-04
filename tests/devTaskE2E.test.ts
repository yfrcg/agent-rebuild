import assert from "node:assert/strict";
import test, { describe, after } from "node:test";
import { existsSync, unlinkSync } from "node:fs";

import {
  createRealApiGateway,
  bypassRequest,
  WORKSPACE,
} from "./helpers/realApiTestHelper";

describe("E2E dev task closed loop (real DeepSeek API)", () => {
  after(() => {
    try {
      const p = `${WORKSPACE}/tests/_e2e_broken_fixture.ts`;
      if (existsSync(p)) unlinkSync(p);
    } catch {}
  });

  test("full loop: model creates failing test → runs → fixes → verifies pass", async () => {
    const { gateway, provider } = createRealApiGateway({ maxSteps: 10 });
    const request = bypassRequest(
      [
        "Create a test file at tests/_e2e_broken_fixture.ts with a test that asserts 1+1 equals 3 (intentionally wrong).",
        "Then run it with: node --require tsx/cjs tests/_e2e_broken_fixture.ts",
        "It should fail. Then fix the assertion to 1+1=2 and run it again to verify it passes.",
        "Report the final result.",
      ].join(" ")
    );

    const response = await gateway.handle(request);
    provider.writeLog("full-loop-e2e");

    console.log("\n=== E2E Dev Task (Real API) ===");
    console.log("Text:", response.text.slice(0, 500));
    console.log("Tool calls:", response.toolCalls.length);
    console.log("API calls:", provider.getRecords().length);
    console.log("finishReason:", response.debug?.autoToolLoop?.finishReason);

    assert.ok(response.text.length > 0, "should have non-empty final text");
    assert.ok(response.toolCalls.length >= 1, `expected >= 1 tool call, got ${response.toolCalls.length}`);
    assert.ok(response.debug?.autoToolLoop?.attempted, "auto tool loop should be attempted");
    assert.equal(response.debug?.devTask?.active, true, "dev task should be active");
    assert.ok(provider.getRecords().length >= 1, "should have made >= 1 API call");
  });

  test("non-dev task does not activate devTask mode (real API)", async () => {
    const { gateway, provider } = createRealApiGateway({ maxSteps: 5 });
    const request = bypassRequest("what is the meaning of life in one sentence");

    const response = await gateway.handle(request);
    provider.writeLog("non-dev-task");

    console.log("\n=== Non-Dev Task (Real API) ===");
    console.log("Text:", response.text.slice(0, 300));
    console.log("devTask:", response.debug?.devTask);
    console.log("API calls:", provider.getRecords().length);

    assert.ok(response.text.length > 0, "should have non-empty text");
    assert.equal(response.debug?.devTask, undefined, "non-dev task should not have devTask");
    assert.ok(provider.getRecords().length >= 1, "should have made >= 1 API call");
  });

  test("model can run commands to gather project info (real API)", async () => {
    const { gateway, provider } = createRealApiGateway({ maxSteps: 5 });
    const request = bypassRequest("run 'node -e \"const p=require('./package.json');console.log(p.name)\"' and tell me the project name");

    const response = await gateway.handle(request);
    provider.writeLog("project-info-real");

    console.log("\n=== Project Info (Real API) ===");
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

  test("model can run a shell command and report result (real API)", async () => {
    const { gateway, provider } = createRealApiGateway({ maxSteps: 5 });
    const request = bypassRequest("run the command 'node -v' and tell me the version");

    const response = await gateway.handle(request);
    provider.writeLog("shell-run-real");

    console.log("\n=== Shell Run (Real API) ===");
    console.log("Text:", response.text.slice(0, 300));
    console.log("Tool calls:", response.toolCalls.length);
    for (const tc of response.toolCalls) {
      console.log(`  [${tc.toolName}] status=${tc.status} duration=${tc.durationMs}ms`);
    }
    console.log("API calls:", provider.getRecords().length);

    assert.ok(response.text.length > 0, "should have non-empty text");
    assert.ok(response.toolCalls.length >= 1, "should have made >= 1 tool call");
    const anyShellSuccess = response.toolCalls.some(
      (tc) => tc.toolName === "shell.run" && tc.status === "success"
    );
    assert.ok(anyShellSuccess, "at least one shell.run should have succeeded");
  });
});
