import * as fs from "fs";
import * as path from "path";
import { getTodayDateString, getYesterdayDateString, resolveWorkspacePath } from "./config";
import type { BootstrapContext, BootstrapFile } from "./types";

function readFileSafe(filePath: string): BootstrapFile {
  const name = path.basename(filePath);

  if (!fs.existsSync(filePath)) {
    return {
      name,
      path: filePath,
      content: "",
      missing: true,
    };
  }

  return {
    name,
    path: filePath,
    content: fs.readFileSync(filePath, "utf8"),
    missing: false,
  };
}

export function loadBootstrapContext(): BootstrapContext {
  const today = getTodayDateString();
  const yesterday = getYesterdayDateString();

  const files = [
    resolveWorkspacePath("AGENTS.md"),
    resolveWorkspacePath("SOUL.md"),
    resolveWorkspacePath("USER.md"),
    resolveWorkspacePath("TOOLS.md"),
    resolveWorkspacePath("WORKFLOW_AUTO.md"),
    resolveWorkspacePath("MEMORY.md"),
    resolveWorkspacePath("memory", `${today}.md`),
    resolveWorkspacePath("memory", `${yesterday}.md`),
  ].map(readFileSafe);

  return {
    bootstrapFiles: files,
    todayMemoryPath: resolveWorkspacePath("memory", `${today}.md`),
  };
}