import { loadSandboxConfig } from "../packages/sandbox/src/config";
import { SandboxManager } from "../packages/sandbox/src/manager";

async function main(): Promise<void> {
  const config = loadSandboxConfig();
  const manager = new SandboxManager({
    config,
  });
  const inspection = await manager.inspect();

  if (!inspection.availability.ok) {
    throw new Error(
      "Docker runtime unavailable. Build agentrebuild-sandbox:latest and ensure Docker is on PATH."
    );
  }

  const result = await manager.exec({
    sessionId: "sandbox-smoke",
    toolName: "sandbox.smoke",
    profileName: "safe-dev",
    command: "node -v && pwd && ls -la /workspace",
    cwd: ".",
    projectRoot: process.cwd(),
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
