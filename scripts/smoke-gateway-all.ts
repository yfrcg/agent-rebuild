import { spawn } from "node:child_process";

interface SmokeCommand {
  name: string;
  npmScript: string;
}

const commands: SmokeCommand[] = [
  {
    name: "Gateway main flow",
    npmScript: "gateway:smoke",
  },
  {
    name: "Gateway memory failure fallback",
    npmScript: "gateway:smoke:memory-failure",
  },
  {
    name: "Gateway model failure fallback",
    npmScript: "gateway:smoke:model-failure",
  },
];

async function main(): Promise<void> {
  console.log("[smoke:all] running Gateway v0.1 smoke tests...\n");

  for (const command of commands) {
    console.log(`[smoke:all] start: ${command.name}`);

    await runNpmScript(command.npmScript);

    console.log(`[smoke:all] passed: ${command.name}\n`);
  }

  console.log("[smoke:all] all Gateway smoke tests passed.");
}

function runNpmScript(scriptName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(`npm run ${scriptName}`, {
            stdio: "inherit",
            shell: true,
          })
        : spawn("npm", ["run", scriptName], {
            stdio: "inherit",
            shell: false,
          });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`npm run ${scriptName} failed with exit code ${code}`));
    });
  });
}

main().catch((error) => {
  console.error("[smoke:all] failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
