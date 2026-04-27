import { randomUUID } from "node:crypto";

import type { TranscriptEntry } from "../core/src/types";

export function createTranscriptEntry(
  role: TranscriptEntry["role"],
  content: string
): TranscriptEntry {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}