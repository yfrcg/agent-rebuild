
import * as fs from "node:fs";
import * as path from "node:path";
import {
  writeDailyMemory,
  writeLongTermMemory,
} from "../memory/src/memoryWriter";
import { resolveWorkspacePath } from "../core/src/config";
import type { GatewayToolCallRecord } from "./toolCallTypes";
import type { SessionMemoryPatch } from "./sessionMemoryManager";
import type { ModelProvider } from "../model/types";

export interface MemoryCandidate {
  content: string;
  kind: "long-term" | "daily";
  score: number;
  source: "input" | "response" | "tool" | "patch";
}

export interface MemoryWriteResult {
  candidates: MemoryCandidate[];
  written: { content: string; kind: "long-term" | "daily"; path: string }[];
  compressed: boolean;
  compressedFrom?: number;
  compressedTo?: number;
}

export interface MemoryAutoWriterConfig {
  memoryMaxChars: number;
  compressTriggerChars: number;
  compressTargetChars: number;
  minImportanceScore: number;
  modelProvider?: ModelProvider;
  writeDailyMemory?: (text: string) => string;
  writeLongTermMemory?: (text: string) => string;
  memoryFilePath?: string;
}

const DEFAULT_CONFIG: MemoryAutoWriterConfig = {
  memoryMaxChars: 50_000,
  compressTriggerChars: 45_000,
  compressTargetChars: 30_000,
  minImportanceScore: 0.6,
};

const LONG_TERM_PATTERNS: RegExp[] = [
  /记住|以后|长期|偏好|习惯|总是|从来|永远|务必|绝对不要|一定不能/,
  /my name is|remember|i prefer|always|never|must not|don't change/i,
  /我是|我叫|我喜欢|我不喜欢|我习惯|我需要/,
  /项目架构|核心决策|设计理念|技术选型|架构决定/,
  /lesson|learned|takeaway|key insight|重要教训|经验总结/i,
];

const ERROR_PATTERNS: RegExp[] = [
  /error|fail|exception|crash|bug|broke|broken/i,
  /报错|失败|异常|崩溃|出错|坏了|不工作/,
  /fix|resolve|solve|workaround|patch|修复|解决|绕过/,
];

const DECISION_PATTERNS: RegExp[] = [
  /决定|选择|采用|改用|切换|迁移到|决定使用/,
  /decide|choose|switch to|migrate|adopt/i,
  /方案|策略|路径|方向/,
];

const TRIVIAL_PATTERNS: RegExp[] = [
  /^(好的?|ok|yes|no|嗯|了解|明白|收到|谢谢|感谢|thank)/i,
  /^(hi|hello|hey|你好|早上好|下午好|晚上好)/i,
  /^.{0,15}$/,
];

/**
 * 函数 `createMemoryAutoWriter` 的职责说明。
 * `createMemoryAutoWriter` 负责创建当前模块需要的对象或请求结构，并集中处理默认值与依赖装配。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
export function createMemoryAutoWriter(
  config?: Partial<MemoryAutoWriterConfig>
): MemoryAutoWriter {
  return new MemoryAutoWriter(config);
}

export class MemoryAutoWriter {
  private config: MemoryAutoWriterConfig;

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(config?: Partial<MemoryAutoWriterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 方法 `evaluateAndWrite` 的职责说明。
   * `evaluateAndWrite` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  evaluateAndWrite(
    input: string,
    response: string,
    toolCalls: GatewayToolCallRecord[],
    patch?: SessionMemoryPatch
  ): MemoryWriteResult {
    const result: MemoryWriteResult = {
      candidates: [],
      written: [],
      compressed: false,
    };

    const candidates = this.extractCandidates(input, response, toolCalls, patch);
    result.candidates = candidates;

    const filtered = candidates.filter(
      (c) => c.score >= this.config.minImportanceScore
    );

    for (const candidate of filtered) {
      try {
        const writer =
          candidate.kind === "long-term"
            ? this.config.writeLongTermMemory ?? writeLongTermMemory
            : this.config.writeDailyMemory ?? writeDailyMemory;
        const filePath = writer(candidate.content);
        result.written.push({
          content: candidate.content,
          kind: candidate.kind,
          path: filePath,
        });
      } catch {
        // best-effort
      }
    }

    const compressed = this.checkAndCompress();
    if (compressed) {
      result.compressed = true;
      result.compressedFrom = compressed.from;
      result.compressedTo = compressed.to;
    }

    return result;
  }

  /**
   * 方法 `extractCandidates` 的职责说明。
   * `extractCandidates` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  extractCandidates(
    input: string,
    response: string,
    toolCalls: GatewayToolCallRecord[],
    patch?: SessionMemoryPatch
  ): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    const inputCandidates = this.extractFromText(input, "input");
    candidates.push(...inputCandidates);

    const responseCandidates = this.extractFromText(response, "response");
    candidates.push(...responseCandidates);

    const toolCandidates = this.extractFromToolCalls(toolCalls);
    candidates.push(...toolCandidates);

    if (patch) {
      const patchCandidates = this.extractFromPatch(patch);
      candidates.push(...patchCandidates);
    }

    return this.deduplicate(candidates);
  }

  /**
   * 方法 `extractFromText` 的职责说明。
   * `extractFromText` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private extractFromText(
    text: string,
    source: "input" | "response"
  ): MemoryCandidate[] {
    if (!text || text.trim().length === 0) return [];

    const candidates: MemoryCandidate[] = [];
    const sentences = this.splitIntoSentences(text);

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed || trimmed.length < 10) continue;
      if (this.isTrivial(trimmed)) continue;

      const score = this.scoreText(trimmed, source);
      if (score < 0.3) continue;

      const kind = this.determineKind(trimmed, score);
      candidates.push({
        content: trimmed.slice(0, 300),
        kind,
        score,
        source,
      });
    }

    return candidates;
  }

  /**
   * 方法 `extractFromToolCalls` 的职责说明。
   * `extractFromToolCalls` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private extractFromToolCalls(
    toolCalls: GatewayToolCallRecord[]
  ): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    const filesTouched: string[] = [];
    const commandsRun: string[] = [];
    const errors: string[] = [];
    const successes: string[] = [];

    for (const tc of toolCalls) {
      if (tc.toolName === "file.write" || tc.toolName === "file.edit") {
        const p = tc.input?.path ?? tc.input?.filePath ?? tc.input?.file_path;
        if (typeof p === "string") filesTouched.push(p);
      }

      if (tc.toolName === "shell.run" || tc.toolName === "bash.run") {
        const cmd = tc.input?.command;
        if (typeof cmd === "string" && cmd.length < 200) {
          commandsRun.push(cmd);
        }
      }

      if (tc.status === "error" && tc.error) {
        errors.push(tc.error.slice(0, 200));
      }

      if (tc.status === "success" && tc.output) {
        const output = typeof tc.output === "string" ? tc.output : "";
        if (
          output.toLowerCase().includes("error") ||
          output.toLowerCase().includes("fail")
        ) {
          errors.push(output.slice(0, 200));
        } else if (output.length > 10) {
          successes.push(output.slice(0, 150));
        }
      }
    }

    if (filesTouched.length > 0) {
      candidates.push({
        content: `Modified files: ${[...new Set(filesTouched)].slice(0, 8).join(", ")}`,
        kind: "daily",
        score: 0.5,
        source: "tool",
      });
    }

    if (commandsRun.length > 0) {
      candidates.push({
        content: `Commands: ${[...new Set(commandsRun)].slice(0, 5).join("; ")}`,
        kind: "daily",
        score: 0.4,
        source: "tool",
      });
    }

    for (const error of errors.slice(0, 3)) {
      candidates.push({
        content: `Error encountered: ${error}`,
        kind: "daily",
        score: 0.7,
        source: "tool",
      });
    }

    for (const success of successes.slice(0, 2)) {
      candidates.push({
        content: `Result: ${success}`,
        kind: "daily",
        score: 0.4,
        source: "tool",
      });
    }

    return candidates;
  }

  /**
   * 方法 `extractFromPatch` 的职责说明。
   * `extractFromPatch` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private extractFromPatch(patch: SessionMemoryPatch): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    if (patch.facts) {
      for (const fact of patch.facts) {
        candidates.push({
          content: fact,
          kind: "long-term",
          score: 0.8,
          source: "patch",
        });
      }
    }

    if (patch.failures) {
      for (const failure of patch.failures.slice(0, 2)) {
        candidates.push({
          content: `Failure: ${failure}`,
          kind: "daily",
          score: 0.65,
          source: "patch",
        });
      }
    }

    if (patch.decisions) {
      for (const decision of patch.decisions.slice(0, 2)) {
        candidates.push({
          content: `Decision: ${decision.decision} — Reason: ${decision.reason}`,
          kind: "long-term",
          score: 0.75,
          source: "patch",
        });
      }
    }

    return candidates;
  }

  /**
   * 方法 `scoreText` 的职责说明。
   * `scoreText` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private scoreText(text: string, source: string): number {
    let score = 0.3;

    for (const pattern of LONG_TERM_PATTERNS) {
      if (pattern.test(text)) {
        score += 0.35;
        break;
      }
    }

    const hasError = ERROR_PATTERNS.some((p) => p.test(text));
    const hasFix = /fix|resolve|solve|修复|解决|成功|works?|passed/i.test(text);
    if (hasError && hasFix) {
      score += 0.3;
    } else if (hasError) {
      score += 0.1;
    }

    for (const pattern of DECISION_PATTERNS) {
      if (pattern.test(text)) {
        score += 0.2;
        break;
      }
    }

    if (source === "input" && text.length > 50) {
      score += 0.1;
    }

    if (text.length > 100) {
      score += 0.05;
    }

    if (/test.*pass|所有测试|全部通过|148 tests/i.test(text)) {
      score += 0.15;
    }

    return Math.min(1, Math.max(0, score));
  }

  /**
   * 方法 `determineKind` 的职责说明。
   * `determineKind` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private determineKind(
    text: string,
    score: number
  ): "long-term" | "daily" {
    if (score >= 0.75) return "long-term";

    for (const pattern of LONG_TERM_PATTERNS) {
      if (pattern.test(text)) return "long-term";
    }

    return "daily";
  }

  /**
   * 方法 `isTrivial` 的职责说明。
   * `isTrivial` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private isTrivial(text: string): boolean {
    return TRIVIAL_PATTERNS.some((p) => p.test(text));
  }

  /**
   * 方法 `splitIntoSentences` 的职责说明。
   * `splitIntoSentences` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private splitIntoSentences(text: string): string[] {
    return text
      .split(/[。！？\n.!?]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * 方法 `deduplicate` 的职责说明。
   * `deduplicate` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private deduplicate(candidates: MemoryCandidate[]): MemoryCandidate[] {
    const seen = new Set<string>();
    const result: MemoryCandidate[] = [];

    for (const c of candidates) {
      const key = c.content.toLowerCase().slice(0, 100);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(c);
    }

    return result.sort((a, b) => b.score - a.score);
  }

  /**
   * 方法 `checkAndCompress` 的职责说明。
   * `checkAndCompress` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  checkAndCompress(): { from: number; to: number } | null {
    const memPath = this.config.memoryFilePath ?? resolveWorkspacePath("MEMORY.md");
    if (!fs.existsSync(memPath)) return null;

    const content = fs.readFileSync(memPath, "utf8");
    if (content.length < this.config.compressTriggerChars) return null;

    const compressed = this.compressHeuristic(content);

    if (compressed.length < this.config.compressTargetChars) {
      fs.writeFileSync(memPath, compressed, "utf8");
      return { from: content.length, to: compressed.length };
    }

    const furtherCompressed = this.compressAggressive(compressed);
    fs.writeFileSync(memPath, furtherCompressed, "utf8");
    return { from: content.length, to: furtherCompressed.length };
  }

  /**
   * 方法 `compressHeuristic` 的职责说明。
   * `compressHeuristic` 负责校验或解析外部输入，把不可信数据收窄成后续流程可安全使用的结构。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  compressHeuristic(content: string): string {
    const lines = content.split("\n");
    const sections: Map<string, string[]> = new Map();
    let currentSection = "__header__";

    for (const line of lines) {
      const sectionMatch = line.match(/^## (.+)$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1].trim();
        if (!sections.has(currentSection)) {
          sections.set(currentSection, []);
        }
        continue;
      }

      if (!sections.has(currentSection)) {
        sections.set(currentSection, []);
      }
      sections.get(currentSection)!.push(line);
    }

    const output: string[] = [];
    for (const [section, sectionLines] of sections) {
      if (section === "__header__") {
        output.push(...sectionLines.filter((l) => l.trim()));
        continue;
      }

      const bullets = sectionLines
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "));

      const unique = [...new Set(bullets)];

      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const bullet of unique) {
        const norm = bullet.toLowerCase().slice(0, 60);
        if (seen.has(norm)) continue;
        seen.add(norm);
        deduped.push(bullet);
      }

      output.push("");
      output.push(`## ${section}`);
      output.push(...deduped);
    }

    return output.join("\n").trim() + "\n";
  }

  /**
   * 方法 `compressAggressive` 的职责说明。
   * `compressAggressive` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  compressAggressive(content: string): string {
    const lines = content.split("\n");
    const headerLines: string[] = [];
    const bullets: string[] = [];
    let inBullet = false;

    for (const line of lines) {
      if (line.startsWith("- ")) {
        inBullet = true;
        bullets.push(line);
      } else if (line.startsWith("#")) {
        inBullet = false;
        headerLines.push(line);
      } else if (!inBullet && line.trim()) {
        headerLines.push(line);
      }
    }

    const sorted = bullets.sort((a, b) => {
      const aLen = a.length;
      const bLen = b.length;
      return aLen - bLen;
    });

    const kept = sorted.slice(-Math.floor(this.config.compressTargetChars / 80));

    const output: string[] = [
      headerLines[0] ?? "# MEMORY.md",
      "",
      "## 长期事实",
      ...kept,
    ];

    return output.join("\n").trim() + "\n";
  }

  /**
   * 方法 `compressWithLLM` 的职责说明。
   * `compressWithLLM` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  async compressWithLLM(content: string): Promise<string> {
    if (!this.config.modelProvider) {
      return this.compressHeuristic(content);
    }

    try {
      const prompt = [
        "You are a memory compression assistant.",
        "Compress the following memory file by removing redundant entries,",
        "merging similar items, and keeping only the most important information.",
        "Preserve all section headers.",
        `Target size: under ${this.config.compressTargetChars} characters.`,
        "Output ONLY the compressed markdown, no explanations.",
        "",
        "Original memory:",
        content,
      ].join("\n");

      const result = await this.config.modelProvider.generate([
        { role: "user", content: prompt },
      ]);

      const compressed = result.text ?? "";

      if (
        compressed.length > 0 &&
        compressed.length < content.length
      ) {
        return compressed;
      }

      return this.compressHeuristic(content);
    } catch {
      return this.compressHeuristic(content);
    }
  }

  /**
   * 方法 `getConfig` 的职责说明。
   * `getConfig` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  getConfig(): Readonly<MemoryAutoWriterConfig> {
    return { ...this.config };
  }

  /**
   * 方法 `updateConfig` 的职责说明。
   * `updateConfig` 负责写入或更新状态，维护时要关注幂等性、失败恢复和数据一致性。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  updateConfig(patch: Partial<MemoryAutoWriterConfig>): void {
    this.config = { ...this.config, ...patch };
  }
}
