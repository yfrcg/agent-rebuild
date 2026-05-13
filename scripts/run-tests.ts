/**
 * ?????CS336 ???
 * ???scripts/run-tests.ts
 * ????????
 * ????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { globSync } from "glob";

const cliPatterns = process.argv.slice(2);
const patterns = cliPatterns.length > 0 ? cliPatterns : ["tests/**/*.test.ts"];

const files = patterns
  .flatMap((pattern) =>
    globSync(pattern, {
      cwd: process.cwd(),
      nodir: true,
      windowsPathsNoEscape: true,
    })
  )
  .map((filePath) => path.resolve(filePath))
  .sort();

if (files.length === 0) {
  console.error(`[test] no test files matched: ${patterns.join(", ")}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  }
);

if (typeof result.status === "number") {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}

process.exit(1);
