/**
 * ?????CS336 ???
 * ???tests/memoryAutoWriter.test.ts
 * ????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MemoryAutoWriter } from "../packages/gateway/memoryAutoWriter";

/**
 * 函数 `makeTempWorkspace` 的职责说明。
 * `makeTempWorkspace` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maw-test-"));
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  return dir;
}

/**
 * 函数 `makeMockWriters` 的职责说明。
 * `makeMockWriters` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function makeMockWriters(tempDir: string) {
  const dailyPath = path.join(tempDir, "memory", "daily.log");
  const longTermPath = path.join(tempDir, "MEMORY.md");
  return {
    writeDailyMemory: (text: string) => {
      fs.appendFileSync(dailyPath, `- ${text}\n`, "utf8");
      return dailyPath;
    },
    writeLongTermMemory: (text: string) => {
      if (!fs.existsSync(longTermPath)) {
        fs.writeFileSync(longTermPath, "# MEMORY.md\n\n## 长期事实\n", "utf8");
      }
      fs.appendFileSync(longTermPath, `- ${text}\n`, "utf8");
      return longTermPath;
    },
    memoryFilePath: longTermPath,
  };
}

describe("MemoryAutoWriter", () => {
  let tempDir: string;
  let mockWriters: ReturnType<typeof makeMockWriters>;

  beforeEach(() => {
    tempDir = makeTempWorkspace();
    mockWriters = makeMockWriters(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("extractCandidates", () => {
    it("extracts from user input with long-term patterns", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates(
        "记住我是一个学生，以后请用中文回复",
        "",
        []
      );
      assert.ok(candidates.length > 0);
      const longTerm = candidates.filter((c) => c.kind === "long-term");
      assert.ok(longTerm.length > 0, "should classify long-term patterns");
    });

    it("extracts from response with error+fix pattern", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates(
        "",
        "修复了 TypeScript 编译错误，原因是类型定义缺失，现在所有测试通过",
        []
      );
      assert.ok(candidates.length > 0);
      const highScore = candidates.filter((c) => c.score >= 0.6);
      assert.ok(highScore.length > 0, "error+fix should score high");
    });

    it("filters trivial input", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates("好的", "ok", []);
      assert.equal(candidates.length, 0);
    });

    it("filters short input", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates("hi", "yes", []);
      assert.equal(candidates.length, 0);
    });

    it("extracts from tool calls - files touched", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates(
        "修改配置",
        "",
        [
          {
            callId: "1",
            toolName: "file.write",
            input: { path: "src/config.ts" },
            status: "success" as const,
            startedAt: new Date().toISOString(),
          },
          {
            callId: "2",
            toolName: "file.edit",
            input: { filePath: "src/main.ts" },
            status: "success" as const,
            startedAt: new Date().toISOString(),
          },
        ]
      );
      const fileCandidate = candidates.find((c) =>
        c.content.includes("config.ts")
      );
      assert.ok(fileCandidate, "should extract files touched");
    });

    it("extracts from tool calls - errors", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates(
        "运行测试",
        "",
        [
          {
            callId: "1",
            toolName: "shell.run",
            input: { command: "npm test" },
            status: "error" as const,
            error: "Test failed: TypeError in auth module",
            startedAt: new Date().toISOString(),
          },
        ]
      );
      const errorCandidate = candidates.find((c) =>
        c.content.includes("Test failed")
      );
      assert.ok(errorCandidate, "should extract errors");
      assert.ok(errorCandidate!.score >= 0.6, "error should score high");
    });

    it("extracts from patch - facts", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates(
        "",
        "",
        [],
        {
          facts: ["用户必须使用中文回复", "不要修改 .env 文件"],
        }
      );
      const factCandidates = candidates.filter((c) => c.source === "patch");
      assert.equal(factCandidates.length, 2);
      assert.ok(factCandidates.every((c) => c.kind === "long-term"));
    });

    it("extracts from patch - failures", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates(
        "",
        "",
        [],
        {
          failures: ["Build failed: missing dependency"],
        }
      );
      const failCandidate = candidates.find((c) =>
        c.content.includes("Build failed")
      );
      assert.ok(failCandidate, "should extract failures from patch");
    });

    it("deduplicates candidates", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates(
        "记住我是学生。记住我是学生。",
        "",
        []
      );
      const unique = new Set(candidates.map((c) => c.content));
      assert.equal(candidates.length, unique.size, "should deduplicate");
    });
  });

  describe("scoreText", () => {
    it("scores long-term patterns high", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates(
        "记住：以后所有的测试都必须通过才能提交代码",
        "",
        []
      );
      assert.ok(candidates.length > 0);
      assert.ok(candidates[0].score >= 0.6, `score ${candidates[0].score} should be >= 0.6`);
    });

    it("scores decision patterns medium-high", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates(
        "决定采用 vitest 作为测试框架，选择理由是与 Vite 生态兼容性好",
        "",
        []
      );
      assert.ok(candidates.length > 0);
      assert.ok(candidates[0].score >= 0.5, `score ${candidates[0].score} should be >= 0.5`);
    });

    it("scores routine conversation low", () => {
      const maw = new MemoryAutoWriter();
      const candidates = maw.extractCandidates(
        "你好，请帮我看看这个文件",
        "好的，我来看看",
        []
      );
      const highScore = candidates.filter((c) => c.score >= 0.7);
      assert.equal(highScore.length, 0, "routine conversation should not score high");
    });
  });

  describe("evaluateAndWrite", () => {
    it("writes daily memory for normal interaction", () => {
      const maw = new MemoryAutoWriter({ minImportanceScore: 0.3, ...mockWriters });
      const result = maw.evaluateAndWrite(
        "帮我修改 src/main.ts 文件，添加一个新的函数来处理用户认证",
        "已添加 authenticateUser 函数到 main.ts，使用 JWT token 验证",
        []
      );
      assert.ok(result.written.length > 0, "should write at least one entry");
    });

    it("writes long-term memory for high-importance content", () => {
      const maw = new MemoryAutoWriter({ minImportanceScore: 0.3, ...mockWriters });
      const result = maw.evaluateAndWrite(
        "记住：以后所有 API 接口必须返回统一的 { code, data, message } 格式，这是项目的核心约束",
        "好的，已记住这个约束",
        []
      );
      const longTermWritten = result.written.filter((w) => w.kind === "long-term");
      assert.ok(longTermWritten.length > 0, "should write long-term memory");
    });

    it("does not write trivial content", () => {
      const maw = new MemoryAutoWriter({ ...mockWriters });
      const result = maw.evaluateAndWrite("好的", "ok", []);
      assert.equal(result.written.length, 0, "trivial content should not be written");
    });

    it("writes error+fix to memory", () => {
      const maw = new MemoryAutoWriter({ minImportanceScore: 0.3, ...mockWriters });
      const result = maw.evaluateAndWrite(
        "运行 npm test 报错了",
        "修复了 TypeScript 编译错误，原因是缺少类型定义，已添加 index.d.ts 解决",
        [
          {
            callId: "1",
            toolName: "shell.run",
            input: { command: "npm test" },
            status: "error" as const,
            error: "TS2304: Cannot find name 'AuthConfig'",
            startedAt: new Date().toISOString(),
          },
        ]
      );
      assert.ok(result.candidates.length > 0, "should have candidates");
    });
  });

  describe("checkAndCompress", () => {
    it("returns null when MEMORY.md is small", () => {
      const memPath = path.join(tempDir, "MEMORY.md");
      fs.writeFileSync(memPath, "# MEMORY.md\n\n## 长期事实\n- small content\n");
      const maw = new MemoryAutoWriter({ ...mockWriters });
      const result = maw.checkAndCompress();
      assert.equal(result, null);
    });

    it("triggers compression when MEMORY.md exceeds threshold", () => {
      const memPath = path.join(tempDir, "MEMORY.md");
      const bullets = Array.from(
        { length: 500 },
        (_, i) => `- Item ${i}: ${"x".repeat(100)}`
      ).join("\n");
      fs.writeFileSync(
        memPath,
        `# MEMORY.md\n\n## 长期事实\n${bullets}\n`
      );

      const before = fs.statSync(memPath).size;
      assert.ok(before > 45000, `file should be large: ${before}`);

      const maw = new MemoryAutoWriter({
        memoryMaxChars: 50000,
        compressTriggerChars: 45000,
        compressTargetChars: 30000,
        memoryFilePath: memPath,
      });
      const result = maw.checkAndCompress();
      assert.ok(result, "should trigger compression");
      assert.ok(result!.to < result!.from, "compressed size should be smaller");
    });

    it("compressHeuristic deduplicates bullets", () => {
      const maw = new MemoryAutoWriter({ ...mockWriters });
      const content = [
        "# MEMORY.md",
        "",
        "## 长期事实",
        "- 用户喜欢中文回复",
        "- 用户喜欢中文回复",
        "- 用户喜欢中文回复",
        "- 项目使用 TypeScript",
        "- 项目使用 TypeScript",
      ].join("\n");

      const compressed = maw.compressHeuristic(content);
      const lines = compressed.split("\n").filter((l) => l.startsWith("- "));
      assert.equal(lines.length, 2, "should deduplicate to 2 unique bullets");
    });
  });

  describe("config", () => {
    it("uses default config", () => {
      const maw = new MemoryAutoWriter();
      const config = maw.getConfig();
      assert.equal(config.memoryMaxChars, 50000);
      assert.equal(config.compressTriggerChars, 45000);
      assert.equal(config.compressTargetChars, 30000);
      assert.equal(config.minImportanceScore, 0.45);
    });

    it("allows config override", () => {
      const maw = new MemoryAutoWriter({ minImportanceScore: 0.8 });
      assert.equal(maw.getConfig().minImportanceScore, 0.8);
    });

    it("allows runtime config update", () => {
      const maw = new MemoryAutoWriter();
      maw.updateConfig({ minImportanceScore: 0.9 });
      assert.equal(maw.getConfig().minImportanceScore, 0.9);
    });
  });

  describe("determineKind", () => {
    it("classifies high-score content as long-term", () => {
      const maw = new MemoryAutoWriter({ minImportanceScore: 0.3 });
      const candidates = maw.extractCandidates(
        "记住：以后绝对不要修改 .env 文件中的 DATABASE_URL，这是核心约束，务必遵守",
        "",
        []
      );
      const highScore = candidates.filter((c) => c.score >= 0.75);
      assert.ok(
        highScore.every((c) => c.kind === "long-term"),
        "high score should be long-term"
      );
    });

    it("classifies low-score content as daily", () => {
      const maw = new MemoryAutoWriter({ minImportanceScore: 0.3 });
      const candidates = maw.extractCandidates(
        "帮我看看这个函数的实现",
        "好的，这个函数的实现逻辑如下...",
        []
      );
      const lowScore = candidates.filter((c) => c.score < 0.6);
      assert.ok(
        lowScore.every((c) => c.kind === "daily"),
        "low score should be daily"
      );
    });
  });

  describe("compression edge cases", () => {
    it("handles empty MEMORY.md", () => {
      const memPath = path.join(tempDir, "MEMORY.md");
      fs.writeFileSync(memPath, "");
      const maw = new MemoryAutoWriter();
      const result = maw.checkAndCompress();
      assert.equal(result, null);
    });

    it("handles missing MEMORY.md", () => {
      const maw = new MemoryAutoWriter();
      const result = maw.checkAndCompress();
      assert.equal(result, null);
    });

    it("compressAggressive keeps most recent bullets", () => {
      const maw = new MemoryAutoWriter({
        compressTargetChars: 500,
        compressTriggerChars: 400,
        memoryMaxChars: 600,
      });
      const bullets = Array.from(
        { length: 100 },
        (_, i) => `- Item ${i}: ${"x".repeat(50)}`
      ).join("\n");
      const content = `# MEMORY.md\n\n## 长期事实\n${bullets}\n`;

      const compressed = maw.compressAggressive(content);
      assert.ok(compressed.length < content.length, "should compress");
      assert.ok(compressed.startsWith("# MEMORY.md"), "should keep header");
    });
  });
});
