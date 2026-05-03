import type { TranscriptEntry } from "../../core/src/types";

export interface TranscriptMemorySummary {
  text: string;
  targetHint: "long-term" | "daily";
}

/**
 * 把一段 transcript 压缩成更适合进入记忆系统的结构化摘要。
 *
 * 当前采用启发式摘要而非模型摘要，目标是：
 * - 降低把原始聊天噪声直接写进记忆的概率
 * - 优先提取用户事实、决策、任务和未解决问题
 */
export function summarizeTranscriptForMemory(
  entries: TranscriptEntry[],
  options: {
    prefix?: string;
    maxItemsPerSection?: number;
  } = {}
): TranscriptMemorySummary {
  const maxItemsPerSection = options.maxItemsPerSection ?? 4;

  const userFacts = collectUniqueLines(
    entries
      .filter((entry) => entry.role === "user")
      .map((entry) => entry.content)
      .flatMap(splitIntoSentences)
      .filter((line) => /记住|以后|我的|我是|喜欢|偏好|习惯|长期/.test(line)),
    maxItemsPerSection
  );

  const tasks = collectUniqueLines(
    entries
      .map((entry) => entry.content)
      .flatMap(splitIntoSentences)
      .filter((line) => /待办|todo|下一步|继续|要做|帮我|请你|需要/.test(line)),
    maxItemsPerSection
  );

  const decisions = collectUniqueLines(
    entries
      .map((entry) => entry.content)
      .flatMap(splitIntoSentences)
      .filter((line) => /决定|改成|采用|保留|不做|已完成|完成了|通过/.test(line)),
    maxItemsPerSection
  );

  const openQuestions = collectUniqueLines(
    entries
      .map((entry) => entry.content)
      .flatMap(splitIntoSentences)
      .filter((line) => /？|\?$|为什么|如何|怎么|接下来/.test(line)),
    maxItemsPerSection
  );

  const highlights = collectUniqueLines(
    entries
      .slice(-8)
      .map((entry) => `${entry.role}: ${normalizeLine(entry.content)}`)
      .filter(Boolean),
    maxItemsPerSection
  );

  const sections: string[] = [];

  if (userFacts.length > 0) {
    sections.push(renderSection("User Facts", userFacts));
  }
  if (tasks.length > 0) {
    sections.push(renderSection("Tasks", tasks));
  }
  if (decisions.length > 0) {
    sections.push(renderSection("Decisions", decisions));
  }
  if (openQuestions.length > 0) {
    sections.push(renderSection("Open Questions", openQuestions));
  }
  if (highlights.length > 0) {
    sections.push(renderSection("Highlights", highlights));
  }

  const fallbackText = entries
    .slice(-6)
    .map((entry) => `${entry.role}: ${normalizeLine(entry.content)}`)
    .filter(Boolean)
    .join(" | ");

  const text = [
    options.prefix ?? "[session summary]",
    sections.length > 0 ? sections.join("\n\n") : fallbackText,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 1200);

  return {
    text,
    targetHint: userFacts.length > 0 || decisions.length > 1 ? "long-term" : "daily",
  };
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/[\n。！？!?]+/g)
    .map(normalizeLine)
    .filter((line) => line.length >= 4);
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function collectUniqueLines(lines: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const normalized = normalizeLine(line);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function renderSection(title: string, lines: string[]): string {
  return [`${title}:`, ...lines.map((line) => `- ${line}`)].join("\n");
}
