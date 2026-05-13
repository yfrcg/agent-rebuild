/**
 * ?????CS336 ???
 * ???packages/gateway/textSanitizer.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */
/**
 * Shared text sanitization utilities for extracting meaningful content
 * from model output that may contain structured JSON payloads.
 *
 * Used by both gateway.ts (HTTP/CLI responses) and ws/router.ts (WebSocket events).
 */

export function extractStructuredJsonRanges(
  raw: string
): Array<{ json: string; start: number; end: number }> {
  const results: Array<{ json: string; start: number; end: number }> = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\" && inString) {
      escapeNext = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push({
          json: raw.slice(start, index + 1),
          start,
          end: index + 1,
        });
        start = -1;
      }
    }
  }

  return results;
}

const TOOL_PARAM_KEYS = new Set([
  "tool", "args", "command", "path", "pattern", "query",
  "dir", "content", "type", "id", "name", "status", "error",
]);

export function extractMeaningfulContent(
  obj: Record<string, unknown>
): string | undefined {
  const priorityKeys = [
    "content", "text", "message", "response", "answer", "result", "output",
  ];
  for (const key of priorityKeys) {
    if (typeof obj[key] === "string" && obj[key].trim()) return obj[key].trim();
  }
  if (
    obj.data &&
    typeof obj.data === "object" &&
    obj.data !== null &&
    !Array.isArray(obj.data)
  ) {
    const nested = extractMeaningfulContent(obj.data as Record<string, unknown>);
    if (nested) return nested;
  }
  let longest = "";
  for (const [key, value] of Object.entries(obj)) {
    if (
      typeof value === "string" &&
      value.length > longest.length &&
      !value.startsWith("{") &&
      !TOOL_PARAM_KEYS.has(key)
    ) {
      longest = value;
    }
  }
  return longest || undefined;
}

export function tryParseStructuredPayload(
  raw: string
): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Fix common JSON malformations from model output:
 * - Arrow syntax: {tool => "value"} → {"tool": "value"}
 * - Unquoted keys: {tool: "value"} → {"tool": "value"}
 * - Dashed keys: {--path: "value"} → {"path": "value"}
 * - Single quotes: {'tool': 'value'} → {"tool": "value"}
 * - Trailing commas: {"a":1,} → {"a":1}
 */
export function fixMalformedJson(raw: string): string {
  let fixed = raw.trim();

  // Remove [/TOOL_CALL] and similar tags
  fixed = fixed.replace(/\[\/?TOOL_CALL\]/gi, "");

  // Fix arrow syntax: => to :
  fixed = fixed.replace(/\s*=>\s*/g, ": ");

  // Fix CLI-style --key "value" (space-separated, no colon) to "key": "value"
  fixed = fixed.replace(/--(\w+)\s+"([^"]*)"/g, '"$1": "$2"');

  // Fix CLI-style --key value (unquoted value) to "key": "value"
  fixed = fixed.replace(/--(\w+)\s+(\S+)/g, '"$1": "$2"');

  // Fix dashed keys: --key to "key"
  fixed = fixed.replace(/(\s|{,)\s*--(\w+)\s*:/g, '$1"$2":');

  // Fix unquoted keys: word followed by colon (but not inside strings)
  fixed = fixed.replace(/(\s|{)(\w+)\s*:/g, '$1"$2":');

  // Fix single quotes to double quotes (simple approach)
  fixed = fixed.replace(/'/g, '"');

  // Fix trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");

  return fixed.trim();
}

/**
 * Extract a balanced JSON object from text that may contain markdown or other content.
 * Returns the first balanced {...} block found, or undefined if none.
 */
export function extractBalancedJson(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escapeNext = true;
      continue;
    }

    if (ch === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

/**
 * Attempt to close a truncated JSON string by adding missing closing braces/brackets.
 */
export function attemptJsonClose(raw: string): string {
  let fixed = raw.trim();

  // Count unmatched opens
  let braceDepth = 0;
  let bracketDepth = 0;
  let inStr = false;
  let esc = false;

  for (const ch of fixed) {
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === "\"") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") braceDepth++;
    if (ch === "}") braceDepth--;
    if (ch === "[") bracketDepth++;
    if (ch === "]") bracketDepth--;
  }

  // Close any unclosed string
  if (inStr) fixed += '"';

  // Close brackets and braces
  while (bracketDepth > 0) { fixed += "]"; bracketDepth--; }
  while (braceDepth > 0) { fixed += "}"; braceDepth--; }

  return fixed;
}

/**
 * Try to parse JSON with automatic fixing of common malformations.
 */
export function tryParseWithFix(raw: string): Record<string, unknown> | undefined {
  // Try direct parse first
  const direct = tryParseStructuredPayload(raw);
  if (direct) return direct;

  // Try with fixes
  const fixed = fixMalformedJson(raw);
  if (fixed !== raw.trim()) {
    return tryParseStructuredPayload(fixed);
  }

  return undefined;
}

/**
 * Clean tool call artifacts from text output.
 * Removes [/TOOL_CALL], [TOOL_CALL], and similar tags.
 * Also removes malformed tool call patterns.
 */
export function cleanToolCallArtifacts(text: string): string {
  return text
    .replace(/\[\/?TOOL_CALL\]/gi, "")
    // Standard format
    .replace(/\{[^{}]*"?\s*tool\s*"?\s*:\s*"[^"]*"[^{}]*\}/g, "")
    // Arrow syntax format
    .replace(/\{\s*tool\s*=>\s*"[^"]*"(?:\s*,\s*args\s*=>\s*\{[^}]*\})?\s*\}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract tool call from MiniMax XML-like format:
 * <minimax:tool_call><invoke name="tool.name","args":{...JSON...}}></invoke></minimax:tool_call>
 *
 * Note: the invoke tag closes with > and the JSON closes with },
 * so the pattern ends with }}>.
 */
function extractMinimaxToolCall(
  raw: string
): { tool: string; args: Record<string, unknown> } | undefined {
  // Match <minimax:tool_call> blocks
  const blockMatch = raw.match(/<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/);
  if (!blockMatch) return undefined;

  const block = blockMatch[1];

  // Extract tool name
  const nameMatch = block.match(/name="([^"]+)"/);
  if (!nameMatch) return undefined;
  const tool = nameMatch[1]?.trim();
  if (!tool) return undefined;

  // Find "args": and extract the JSON object using brace-depth matching
  const argsKeyIdx = block.indexOf('"args":');
  if (argsKeyIdx < 0) return undefined;

  const jsonStart = block.indexOf("{", argsKeyIdx);
  if (jsonStart < 0) return undefined;

  // Extract balanced JSON using brace depth
  let depth = 0;
  let jsonEnd = -1;
  let inStr = false;
  let esc = false;
  for (let i = jsonStart; i < block.length; i++) {
    const ch = block[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === "\"") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) { jsonEnd = i; break; }
    }
  }
  if (jsonEnd < 0) return undefined;

  let argsStr = block.slice(jsonStart, jsonEnd + 1);

  // Fix unescaped backslashes in Windows paths (D:\WorkStation -> D:\\WorkStation)
  // Match a backslash NOT preceded by another backslash and NOT followed by a valid JSON escape char
  argsStr = argsStr.replace(/(?<!\\)\\(?!["\\\/bfnrtu])/g, "\\\\");

  const args = tryParseWithFix(argsStr);
  if (args && typeof args === "object") {
    return { tool, args: args as Record<string, unknown> };
  }

  return undefined;
}

/**
 * Extract tool call intent from malformed model output.
 *
 * Handles cases like:
 * - {tool: "file.list", args: {path: "yanghui"}}
 * - {tool => "file.list", args => {--path "yanghui"}}
 * - [/TOOL_CALL]
 * - {type: "tool_call", tool: "file.read", args: {...}}
 */
export function extractToolCallIntent(
  raw: string
): { tool: string; args: Record<string, unknown> } | undefined {
  // First try to extract from MiniMax XML-like tool call format:
  // <minimax:tool_call><invoke name="tool.name","args":{...}}></invoke></minimax:tool_call>
  const xmlToolCall = extractMinimaxToolCall(raw);
  if (xmlToolCall) return xmlToolCall;

  // Then try to extract a balanced JSON block from the raw text
  // (handles markdown prefix like "## 第一步\n\n{tool: ...}")
  const jsonBlock = extractBalancedJson(raw);
  const textToParse = jsonBlock ?? raw;

  // Try to find a JSON-like structure with tool/args
  // Use brace-depth-aware extraction for args bodies
  const patterns: Array<{ toolRe: RegExp; argsGroupIdx: number }> = [
    // Arrow syntax: {tool => "name", args => {...}}
    { toolRe: /\{\s*tool\s*=>\s*"([^"]+)"\s*,\s*args\s*=>\s*/, argsGroupIdx: 1 },
    // Standard format with potential malformations
    { toolRe: /\{[^{}]*"?\s*tool\s*"?\s*:\s*"([^"]+)"[^{}]*"?\s*args\s*"?\s*:\s*/, argsGroupIdx: 1 },
    // Format without quotes around keys
    { toolRe: /\{\s*tool\s*:\s*"([^"]+)"\s*,\s*args\s*:\s*/, argsGroupIdx: 1 },
    // Format with type field
    { toolRe: /\{[^{}]*"?\s*type\s*"?\s*:\s*"(?:tool_call|tool)"[^{}]*"?\s*tool\s*"?\s*:\s*"([^"]+)"[^{}]*"?\s*args\s*"?\s*:\s*/, argsGroupIdx: 1 },
  ];

  for (const { toolRe } of patterns) {
    const match = textToParse.match(toolRe);
    if (!match) continue;

    const tool = match[1]?.trim();
    if (!tool) continue;

    // Find where args starts (after the match)
    const argsStart = (match.index ?? 0) + match[0].length;
    // Extract balanced args using brace depth
    const argsStr = extractBalancedObject(textToParse, argsStart);
    if (!argsStr) continue;

    const args = tryParseWithFix(argsStr);
    if (args && typeof args === "object") {
      return { tool, args: args as Record<string, unknown> };
    }
  }

  // Try to extract from the entire text with fixMalformedJson
  // But only apply to the JSON portion, not markdown
  const fixed = fixMalformedJson(textToParse);
  const parsed = tryParseWithFix(fixed);
  if (parsed && typeof parsed.tool === "string") {
    const args = (parsed.args ?? parsed.params ?? parsed.input ?? parsed.arguments) as Record<string, unknown> | undefined;
    if (args && typeof args === "object") {
      return { tool: parsed.tool, args };
    }
  }

  // Last resort: try the full raw text with fixes (for edge cases)
  if (textToParse !== raw) {
    const fixedRaw = fixMalformedJson(raw);
    const parsedRaw = tryParseWithFix(fixedRaw);
    if (parsedRaw && typeof parsedRaw.tool === "string") {
      const args = (parsedRaw.args ?? parsedRaw.params ?? parsedRaw.input ?? parsedRaw.arguments) as Record<string, unknown> | undefined;
      if (args && typeof args === "object") {
        return { tool: parsedRaw.tool, args };
      }
    }
  }

  return undefined;
}

/**
 * Extract a balanced {...} object starting at the given position.
 * Returns the string including outer braces, or undefined.
 */
function extractBalancedObject(text: string, start: number): string | undefined {
  if (start >= text.length || text[start] !== "{") return undefined;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) { escapeNext = false; continue; }
    if (ch === "\\" && inString) { escapeNext = true; continue; }
    if (ch === "\"") { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  // Truncated — try to close it
  const slice = text.slice(start);
  const closed = attemptJsonClose(slice);
  const reparsed = tryParseWithFix(closed);
  if (reparsed && typeof reparsed === "object") {
    return closed;
  }

  return undefined;
}
