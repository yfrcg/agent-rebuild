import * as fs from "fs";
import { ensureDir, resolveWorkspacePath } from "../../core/src/config";
import type { TranscriptEntry } from "../../core/src/types";

export function appendTranscript(sessionId: string, entry: TranscriptEntry) {
  ensureDir(resolveWorkspacePath("sessions"));
  const filePath = resolveWorkspacePath("sessions", `${sessionId}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

export function readTranscript(sessionId: string): TranscriptEntry[] {
  const filePath = resolveWorkspacePath("sessions", `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptEntry);
}