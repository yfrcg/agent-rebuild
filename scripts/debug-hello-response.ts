import { createGatewayRuntime } from "../packages/gateway/runtime";

async function main() {
  const rt = await createGatewayRuntime();
  const s = rt.sessionManager.createSession("Hello Debug");

  console.log("=== Sending '你好' to gateway ===\n");

  const r = await rt.gateway.handle({
    id: `hello-${Date.now()}`,
    input: "你好",
    sessionId: s.id,
    permissionMode: "default",
    createdAt: new Date().toISOString(),
  });

  console.log("--- GatewayResponse ---");
  console.log("text length:", r.text?.length ?? 0);
  console.log("text:", JSON.stringify(r.text));
  console.log("toolCalls:", r.toolCalls?.length ?? 0);
  console.log("error:", r.error ?? "none");

  if (r.toolCalls) {
    for (const tc of r.toolCalls) {
      console.log(`  tool: ${tc.toolName}, status: ${tc.status}`);
    }
  }

  await rt.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
