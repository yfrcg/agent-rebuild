/**
 * ?????CS336 ???
 * ???scripts/test-memory-system.ts
 * ????????
 * ????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
/**
 * Memory System E2E Test
 *
 * Tests whether the memory system actually works in a real API conversation:
 * 1. Can memory search find existing memories?
 * 2. Does the context builder inject memory results into model context?
 * 3. Can the model recall information from previous sessions?
 *
 * Usage: npx tsx scripts/test-memory-system.ts
 */

import { createGatewayRuntime } from "../packages/gateway/runtime";
import type { GatewayRuntime } from "../packages/gateway/runtime";
import { hybridSearch } from "../packages/memory/src/hybridSearch";
import { writeLongTermMemory, writeDailyMemory } from "../packages/memory/src/memoryWriter";

const TEST_TAG = `[test-memory-${Date.now()}]`;

async function main() {
  console.log("=== Memory System E2E Test ===\n");

  // --- Part 1: Direct memory search test ---
  console.log("[Part 1] Testing hybridSearch directly...\n");

  const testQueries = [
    "用户叫什么名字",
    "项目架构",
    "喜欢什么运动",
    "Windows 命令",
  ];

  for (const query of testQueries) {
    const results = await hybridSearch(query, 3);
    console.log(`  Query: "${query}"`);
    console.log(`  Results: ${results.length}`);
    for (const r of results) {
      console.log(`    [${r.source}] score=${r.score?.toFixed(4)} content="${r.content?.slice(0, 80)}..."`);
    }
    console.log();
  }

  // --- Part 2: Write a unique memory, then search for it ---
  console.log("[Part 2] Write unique test memory, then search...\n");

  const uniqueFact = `${TEST_TAG} 这是一条端到端测试记忆，用于验证记忆写入和检索是否正常工作。测试时间: ${new Date().toISOString()}`;

  try {
    const writePath = writeDailyMemory(uniqueFact);
    console.log(`  Written to: ${writePath}`);
  } catch (err) {
    console.error(`  Write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Wait a moment for indexing
  await new Promise(resolve => setTimeout(resolve, 1000));

  const searchResults = await hybridSearch("端到端测试记忆", 3);
  console.log(`  Search results for "端到端测试记忆": ${searchResults.length}`);
  for (const r of searchResults) {
    console.log(`    [${r.source}] score=${r.score?.toFixed(4)} content="${r.content?.slice(0, 100)}"`);
  }
  const found = searchResults.some(r => r.content?.includes("端到端测试记忆"));
  console.log(`  Found test memory: ${found ? "YES" : "NO"}`);

  // --- Part 3: Test with real gateway runtime ---
  console.log("\n[Part 3] Testing memory in real gateway API call...\n");

  let runtime: GatewayRuntime;
  try {
    runtime = await createGatewayRuntime();
    console.log(`  Model: ${runtime.modelProvider.name}`);
  } catch (err) {
    console.error(`  Runtime creation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Create a session
  const session = runtime.sessionManager.createSession("Memory Test");
  console.log(`  Session: ${session.id}`);

  // First request: tell the agent something memorable
  console.log("\n  [Step A] Sending memorable information...");
  try {
    const response1 = await runtime.gateway.handle({
      id: `memory-test-1-${Date.now()}`,
      input: "请记住：我最喜欢的编程语言是 Rust，我的生日是 10 月 15 日。请用 memory.write 工具保存这些信息。",
      sessionId: session.id,
      permissionMode: "default",
      createdAt: new Date().toISOString(),
    });

    console.log(`  Response 1 status: ${response1.error ? "ERROR" : "OK"}`);
    console.log(`  Tool calls: ${response1.toolCalls?.length ?? 0}`);
    if (response1.toolCalls) {
      for (const tc of response1.toolCalls) {
        console.log(`    - ${tc.toolName}: ${tc.status}`);
      }
    }
    console.log(`  Response text (first 200): ${response1.text?.slice(0, 200) ?? "(empty)"}`);
  } catch (err) {
    console.error(`  Request 1 failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Wait for memory indexing
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Second request: ask about the information (should recall from memory)
  console.log("\n  [Step B] Asking about previously shared information...");
  try {
    const response2 = await runtime.gateway.handle({
      id: `memory-test-2-${Date.now()}`,
      input: "你还记得我最喜欢的编程语言是什么吗？我的生日是哪天？",
      sessionId: session.id,
      permissionMode: "default",
      createdAt: new Date().toISOString(),
    });

    console.log(`  Response 2 status: ${response2.error ? "ERROR" : "OK"}`);
    console.log(`  Tool calls: ${response2.toolCalls?.length ?? 0}`);
    if (response2.toolCalls) {
      for (const tc of response2.toolCalls) {
        console.log(`    - ${tc.toolName}: ${tc.status}`);
      }
    }
    console.log(`  Response text (first 300): ${response2.text?.slice(0, 300) ?? "(empty)"}`);

    // Check if the model recalled the information
    const text = response2.text ?? "";
    const recallsRust = /rust/i.test(text);
    const recallsBirthday = /10.*15|十月|October/i.test(text);
    console.log(`\n  Recall check:`);
    console.log(`    Rust: ${recallsRust ? "YES" : "NO"}`);
    console.log(`    Birthday (10/15): ${recallsBirthday ? "YES" : "NO"}`);
  } catch (err) {
    console.error(`  Request 2 failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await runtime.close();

  // --- Summary ---
  console.log("\n=== Summary ===");
  console.log("  Memory search: " + (found ? "PASS" : "NEEDS CHECK"));
  console.log("  See above for full conversation results.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
