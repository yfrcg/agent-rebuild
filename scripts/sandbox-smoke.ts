import { loadSandboxConfig } from "../packages/sandbox/src/config";
import { SandboxManager } from "../packages/sandbox/src/manager";

async function main(): Promise<void> {
  const config = loadSandboxConfig();
  const manager = new SandboxManager({
    config,
  });
  const inspection = await manager.inspect();

  if (inspection.config.backend === "mock") {
    console.log("[mock sandbox] no real container isolation");
  } else if (!inspection.availability.ok) {
    throw new Error(
      "Docker runtime unavailable. Run this in Linux VM or set GATEWAY_SANDBOX_BACKEND=mock for development tests."
    );
  }

  const result = await manager.exec({
    sessionId: "sandbox-smoke",
    toolCallId: `sandbox-smoke-${Date.now()}`,
    toolName: "sandbox.smoke",
    command: "sh",
    args: [
      "-lc",
      "node -v && pwd && ls -la /workspace && echo hello > /artifacts/hello.txt",
    ],
    cwd: process.cwd(),
    riskLevel: "high",
  });

  console.log("[sandbox smoke result]");
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[sandbox:smoke] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
