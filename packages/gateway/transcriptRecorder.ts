import { appendTranscript } from "../session/src/transcript";
import type { TranscriptEntry } from "../core/src/types";
import { createTranscriptEntry } from "./transcriptEntryFactory";

export function createGatewaySessionId(): string {
  return `session-${Date.now()}`;
}

export function recordTranscript(
  sessionId: string,
  role: TranscriptEntry["role"],
  content: string
): void {
  appendTranscript(sessionId, createTranscriptEntry(role, content));
}