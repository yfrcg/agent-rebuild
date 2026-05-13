/**
 * ?????CS336 ???
 * ???scripts/test-agent-fix-errors.ts
 * ????????
 * ????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
/**
 * Agent Error Detection & Fix E2E Test
 *
 * Tests whether the agent can:
 * 1. Run error_case.py, detect errors, and fix them
 * 2. Run error_case.cpp, detect errors, and fix them
 *
 * Uses real API calls through the gateway.
 *
 * Usage: npx tsx scripts/test-agent-fix-errors.ts
 */

import { createGatewayRuntime } from "../packages/gateway/runtime";
import type { GatewayRuntime } from "../packages/gateway/runtime";

async function main() {
  console.log("=== Agent Error Detection & Fix E2E Test ===\n");

  let runtime: GatewayRuntime;
  try {
    runtime = await createGatewayRuntime();
    console.log(`Model: ${runtime.modelProvider.name}`);
  } catch (err) {
    console.error(`Runtime creation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Create a session bound to CoLab directory
  const session = runtime.sessionManager.createSession("Error Fix Test");
  runtime.sessionManager.bindProjectDir(session.id, "D:\\WorkStation\\CoLab");
  console.log(`Session: ${session.id}`);
  console.log(`Project dir: D:\\WorkStation\\CoLab\n`);

  // --- Test 1: Python file ---
  console.log("━".repeat(60));
  console.log("[Test 1] Python: Run error_case.py, detect & fix errors");
  console.log("━".repeat(60));

  try {
    const response1 = await runtime.gateway.handle({
      id: `fix-py-${Date.now()}`,
      input: `请执行 python D:\\WorkStation\\CoLab\\error_case.py，观察报错信息，然后修复文件中的所有错误，修复后再次运行验证。请用中文回复。`,
      sessionId: session.id,
      permissionMode: "default",
      createdAt: new Date().toISOString(),
    });

    console.log(`\nStatus: ${response1.error ? "ERROR" : "OK"}`);
    console.log(`Tool calls: ${response1.toolCalls?.length ?? 0}`);
    if (response1.toolCalls) {
      for (const tc of response1.toolCalls) {
        const statusIcon = tc.status === "success" ? "✓" : tc.status === "error" ? "✗" : "…";
        console.log(`  ${statusIcon} ${tc.toolName}: ${tc.status}`);
      }
    }
    console.log(`\nAgent response:\n${response1.text ?? "(empty)"}\n`);
  } catch (err) {
    console.error(`Test 1 failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Note: C++ test skipped — g++ has DLL dependency issue in this environment
  // (cc1.exe needs MSYS2 ucrt64/bin in PATH). This is a system config issue, not an agent issue.

  await runtime.close();
  console.log("=== Test Complete ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
