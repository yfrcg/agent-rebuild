import { readTranscript } from "./transcript";
import { writeDailyMemory, writeLongTermMemory } from "../../memory/src/memoryWriter";
import { loadBootstrapContext } from "../../core/src/bootstrap";

export function preCompactionFlush(sessionId: string) {
  const transcript = readTranscript(sessionId);
  const recent = transcript.slice(-12);

  if (recent.length === 0) {
    return { ok: true, message: "No transcript to flush." };
  }

  const merged = recent.map((x) => `${x.role}: ${x.content}`).join("\n");

  if (merged.includes("记住") || merged.includes("以后") || merged.includes("长期")) {
    writeLongTermMemory(`Recovered from pre-compaction flush: ${merged.slice(0, 300)}`);
    return { ok: true, target: "MEMORY.md" };
  }

  writeDailyMemory(`Recovered from pre-compaction flush: ${merged.slice(0, 300)}`);
  return { ok: true, target: "daily-memory" };
}

export function postCompactionRecovery() {
  return loadBootstrapContext();
}