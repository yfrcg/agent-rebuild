import { compactTranscript } from "../session/src/compact";
import { readTranscript } from "../session/src/transcript";

export interface SessionAutoCompactionOptions {
  enabled: boolean;
  maxEntries: number;
}

/**
 * 在 transcript 过长时触发一次自动压缩。
 *
 * 这里基于“当前真实消息条数”而不是累计 messageCount 判断，
 * 这样压缩后阈值会自然回落，不会出现每轮都重复触发的问题。
 */
export function maybeAutoCompactSession(
  sessionId: string,
  options: SessionAutoCompactionOptions
) {
  if (!options.enabled) {
    return undefined;
  }

  const transcript = readTranscript(sessionId);
  if (transcript.length < options.maxEntries) {
    return undefined;
  }

  return compactTranscript(sessionId);
}
