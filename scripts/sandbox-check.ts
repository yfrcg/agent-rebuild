import { loadSandboxConfig } from "../packages/sandbox/src/config";
import { SandboxManager } from "../packages/sandbox/src/manager";

async function main(): Promise<void> {
  const config = loadSandboxConfig();
  const manager = new SandboxManager({
    config,
  });
  const inspection = await manager.inspect();

  console.log("[sandbox config]");
  console.log(JSON.stringify(inspection.config, null, 2));
  console.log("");
  console.log("[sandbox availability]");
  console.log(JSON.stringify(inspection.availability, null, 2));

  if (inspection.config.backend === "mock") {
    console.log("");
    console.log("[mock sandbox] no real container isolation");
    return;
  }

  if (!inspection.availability.ok && inspection.config.requireRuntime) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[sandbox:check] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
