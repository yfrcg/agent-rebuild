/**
 * ?????CS336 ???
 * ???scripts/smoke-gateway-all.ts
 * ????????
 * ????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { spawn } from "node:child_process";

/**
 * 单个 smoke 子任务的定义。
 */
interface SmokeCommand {
  name: string;
  npmScript: string;
}

/**
 * 需要顺序执行的全部 smoke 脚本。
 */
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

/**
 * 顺序执行全部 smoke 测试脚本。
 *
 * 使用顺序执行而不是并发执行，
 * 是为了让终端日志更清晰，也避免多个脚本并发争用同一环境资源。
 */
async function main(): Promise<void> {
  console.log("[smoke:all] running Gateway v0.1 smoke tests...\n");

  for (const command of commands) {
    console.log(`[smoke:all] start: ${command.name}`);
    await runNpmScript(command.npmScript);
    console.log(`[smoke:all] passed: ${command.name}\n`);
  }

  console.log("[smoke:all] all Gateway smoke tests passed.");
}

/**
 * 执行单个 npm script，并把标准输入输出直接透传到当前终端。
 */
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
