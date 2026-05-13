/**
 * End-to-end test: verify the gateway agent can create files in D:\WorkStation\CoLab
 *
 * Usage: npx tsx scripts/test-colab-file-creation.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createGatewayRuntime } from "../packages/gateway/runtime";

const PROJECT_DIR = "D:\\WorkStation\\CoLab";

async function main() {
  console.log("=== CoLab File Creation E2E Test ===\n");

  // Step 1: Create runtime
  console.log("[1] Creating gateway runtime...");
  const runtime = await createGatewayRuntime();
  console.log(`    Model: ${runtime.modelProvider.name}`);
  console.log(`    Project root: ${runtime.projectRoot}`);

  // Step 2: Create a new session and bind to CoLab
  console.log("\n[2] Creating session and binding to CoLab...");
  const session = runtime.sessionManager.createSession("CoLab Test");
  console.log(`    Session: ${session.id}`);

  try {
    const { session: boundSession, scan } = runtime.sessionManager.bindProjectDir(
      session.id,
      PROJECT_DIR
    );
    console.log(`    Bound to: ${boundSession.projectDir}`);
    console.log(`    Permission: ${boundSession.permission}`);
    console.log(`    Allowed write: ${boundSession.allowedWriteRoots.join(", ")}`);
  } catch (err) {
    console.error(`    Bind failed: ${err instanceof Error ? err.message : String(err)}`);
    await runtime.close();
    process.exit(1);
  }

  // Step 3: Send request to create files
  console.log("\n[3] Sending request to create files...");
  const requestInput = [
    "请在当前项目目录中完成以下操作：",
    "1. 创建一个名为 'my_project' 的文件夹",
    "2. 在 my_project 文件夹中创建一个 Python 文件 hello.py，内容为 print('Hello from Python!')",
    "3. 在 my_project 文件夹中创建一个 C++ 文件 main.cpp，内容为一个简单的 Hello World 程序",
    "",
    "请使用 file.write 工具创建这些文件。",
  ].join("\n");

  const request = {
    id: `test-${Date.now()}`,
    input: requestInput,
    sessionId: session.id,
    permissionMode: "default" as const,
    createdAt: new Date().toISOString(),
  };

  console.log(`    Request input length: ${requestInput.length} chars`);
  console.log("    Waiting for response...\n");

  try {
    const response = await runtime.gateway.handle(request);

    console.log("=== Response ===");
    console.log(`    Status: ${response.error ? "ERROR" : "OK"}`);
    console.log(`    Tool calls: ${response.toolCalls?.length ?? 0}`);

    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const tc of response.toolCalls) {
        console.log(`    - ${tc.toolName}: ${tc.status} ${tc.error ? `(${tc.error})` : ""}`);
        if (tc.input) {
          const inputPreview = JSON.stringify(tc.input).slice(0, 200);
          console.log(`      Input: ${inputPreview}`);
        }
      }
    }

    if (response.debug?.autoToolLoop) {
      const loop = response.debug.autoToolLoop;
      console.log(`\n    Auto tool loop:`);
      console.log(`      Enabled: ${loop.enabled}`);
      console.log(`      Attempted: ${loop.attempted}`);
      console.log(`      Tool calls: ${loop.toolCallCount}`);
      console.log(`      Finish reason: ${loop.finishReason}`);
      if (loop.decisionTrace) {
        for (const d of loop.decisionTrace) {
          console.log(`      Step ${d.step}: ${d.action} - ${d.reason ?? ""} ${d.status ?? ""}`);
        }
      }
    }

    console.log(`\n    Response text (first 500 chars):`);
    console.log(`    ${response.text?.slice(0, 500) ?? "(empty)"}`);

    // Step 4: Check if files exist
    console.log("\n=== File Verification ===");
    const expectedFiles = [
      path.join(PROJECT_DIR, "my_project"),
      path.join(PROJECT_DIR, "my_project", "hello.py"),
      path.join(PROJECT_DIR, "my_project", "main.cpp"),
    ];

    let allExist = true;
    for (const filePath of expectedFiles) {
      const exists = fs.existsSync(filePath);
      const type = exists ? (fs.statSync(filePath).isDirectory() ? "DIR" : "FILE") : "MISSING";
      console.log(`    ${exists ? "OK" : "MISSING"} [${type}] ${filePath}`);

      if (exists && type === "FILE") {
        const content = fs.readFileSync(filePath, "utf8");
        console.log(`      Content: ${content.slice(0, 200)}`);
      }

      if (!exists) allExist = false;
    }

    console.log(`\n=== Result: ${allExist ? "SUCCESS" : "FAILURE"} ===`);

    if (!allExist) {
      console.log("\nDebugging info:");
      console.log(`  Response error: ${response.error ?? "none"}`);
      if (response.toolCalls) {
        const failed = response.toolCalls.filter((tc) => tc.status !== "success");
        for (const tc of failed) {
          console.log(`  Failed tool: ${tc.toolName} - ${tc.error ?? "unknown error"}`);
        }
      }
    }
  } catch (err) {
    console.error(`    Request failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
  }

  await runtime.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
