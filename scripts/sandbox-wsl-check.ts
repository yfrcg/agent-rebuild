import { loadEnvFile } from "../packages/gateway/env";
import { WslSandboxClient } from "../packages/sandbox-client/src";
import {
  DEFAULT_WINDOWS_PROJECT_ROOT,
  DEFAULT_WSL_PROJECT_ROOT,
} from "../packages/core/src/config";

async function main(): Promise<void> {
  loadEnvFile();

  const sandboxMode = process.env.SANDBOX_MODE?.trim().toLowerCase();
  const windowsProjectRoot =
    process.env.WINDOWS_PROJECT_ROOT?.trim() || DEFAULT_WINDOWS_PROJECT_ROOT;

  if (sandboxMode !== "wsl") {
    throw new Error(`SANDBOX_MODE must be wsl, received: ${process.env.SANDBOX_MODE ?? "(unset)"}`);
  }

  const client = new WslSandboxClient();
  const health = await client.health();

  console.log("[sandbox:wsl:check] health");
  console.log(JSON.stringify(health, null, 2));

  if (!health.ok) {
    throw new Error("WSL sandbox worker is unavailable. Start ~/sandbox-worker first.");
  }

  const healthPayload = parseJson(health.body);
  if (healthPayload?.allowedRoot !== DEFAULT_WSL_PROJECT_ROOT) {
    throw new Error(
      `Unexpected allowedRoot: ${String(healthPayload?.allowedRoot)}`
    );
  }
  if (healthPayload?.useDocker !== true) {
    throw new Error(`WSL worker is not configured for Docker execution.`);
  }

  const result = await client.run({
    command: "node -v",
    cwd: windowsProjectRoot,
    windowsCwd: windowsProjectRoot,
    timeoutMs: 30_000,
    workspaceMount: windowsProjectRoot,
    envAllowlist: ["CI", "NODE_ENV"],
    networkPolicy: "disabled",
    resourceLimits: {
      memoryMb: 512,
      cpus: 1,
      pidsLimit: 64,
      maxOutputBytes: 64 * 1024,
    },
  });

  console.log("[sandbox:wsl:check] run");
  console.log(JSON.stringify(result, null, 2));

  if (
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    (typeof result.exitCode !== "number" && result.exitCode !== null) ||
    typeof result.durationMs !== "number" ||
    typeof result.timedOut !== "boolean" ||
    !Array.isArray(result.artifacts)
  ) {
    throw new Error("Sandbox result shape is invalid.");
  }

  if (!result.ok) {
    throw new Error(`Sandbox run failed: ${result.stderr || `exitCode=${result.exitCode}`}`);
  }
}

function parseJson(input: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

main().catch((error) => {
  console.error(
    "[sandbox:wsl:check] failed:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
