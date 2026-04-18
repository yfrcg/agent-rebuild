import * as fs from "fs";
import { resolveWorkspacePath } from "../../core/src/config";

export function memoryGet(file: string, startLine?: number, endLine?: number) {
  const filePath = resolveWorkspacePath(file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Memory file not found: ${file}`);
  }

  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const s = startLine ? Math.max(1, startLine) : 1;
  const e = endLine ? Math.min(lines.length, endLine) : lines.length;

  return {
    file,
    startLine: s,
    endLine: e,
    text: lines.slice(s - 1, e).join("\n"),
  };
}