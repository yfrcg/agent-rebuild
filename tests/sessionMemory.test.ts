
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { ContextBuilder } from "../packages/gateway/contextBuilder";
import { ContextCompressor } from "../packages/gateway/contextCompressor";
import { SessionManager } from "../packages/gateway/sessionManager";
import { SessionStore } from "../packages/gateway/sessionStore";
import {
  SessionMemoryManager,
  type SessionMemoryPatch,
  type WorkingMemory,
} from "../packages/gateway/sessionMemoryManager";

/**
 * 函数 `createTempWorkspace` 的职责说明。
 * `createTempWorkspace` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createTempWorkspace(): string {
  const dir = path.join(os.tmpdir(), `agent-sm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  return dir;
}

/**
 * 函数 `createTestProjectDir` 的职责说明。
 * `createTestProjectDir` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createTestProjectDir(workspace: string, name = "test-project"): string {
  const projectDir = path.join(workspace, name);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), '{"name":"test"}', "utf8");
  return projectDir;
}

/**
 * 函数 `createSessionManager` 的职责说明。
 * `createSessionManager` 用于固定测试场景中的一个可观察行为，重点验证输入、输出、异常分支和回归边界。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function createSessionManager(workspace: string): SessionManager {
  const snapshotPath = path.join(workspace, "sessions.json");
  return new SessionManager(new SessionStore(snapshotPath), workspace);
}

test("1. createSession initializes working-memory.json", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const smm = new SessionMemoryManager(sessionId, workspace);
    const wmPath = path.join(workspace, "sessions", sessionId, "working-memory.json");
    assert.ok(fs.existsSync(wmPath), "working-memory.json should exist");

    const wm = smm.readWorkingMemory();
    assert.equal(wm.sessionGoal, "");
    assert.equal(wm.projectDir, "");
    assert.deepEqual(wm.currentPlan, []);
    assert.deepEqual(wm.filesTouched, []);
    assert.ok(wm.updatedAt);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("2. createSession initializes rolling-summary.md", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const smm = new SessionMemoryManager(sessionId, workspace);
    const rsPath = path.join(workspace, "sessions", sessionId, "rolling-summary.md");
    assert.ok(fs.existsSync(rsPath), "rolling-summary.md should exist");

    const content = smm.readRollingSummary();
    assert.ok(content.includes("Rolling Summary"), "should contain header");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("3. bindProjectDir writes projectDir to working-memory.json", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const projectDir = createTestProjectDir(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.bindProjectDir(sessionId, projectDir, [workspace]);

    const smm = new SessionMemoryManager(sessionId, workspace);
    const wm = smm.readWorkingMemory();
    assert.equal(wm.projectDir, projectDir);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("4. applyPatch updates filesTouched and commandsRun in working-memory", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const smm = new SessionMemoryManager(sessionId, workspace);
    smm.applyPatch({
      filesTouched: ["src/foo.ts", "src/bar.ts"],
      commandsRun: ["npm test", "git status"],
      goal: "Fix the bug",
    });

    const wm = smm.readWorkingMemory();
    assert.deepEqual(wm.filesTouched, ["src/foo.ts", "src/bar.ts"]);
    assert.deepEqual(wm.commandsRun, ["npm test", "git status"]);
    assert.equal(wm.sessionGoal, "Fix the bug");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("5. rolling-summary.md is non-empty after writeRollingSummary", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const smm = new SessionMemoryManager(sessionId, workspace);
    smm.writeRollingSummary("# Current Progress\n\n- Fixed type error in foo.ts\n- Tests passing\n");

    const content = smm.readRollingSummary();
    assert.ok(content.length > 0);
    assert.ok(content.includes("Fixed type error"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("6. buildContext injects rolling-summary.md content", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const smm = new SessionMemoryManager(sessionId, workspace);
    smm.writeRollingSummary("# Progress\n\nFixed all bugs. Tests pass.\n");

    const sessionMemoryContext = smm.buildWorkingMemorySummary() + "\n\n" + smm.buildRollingSummarySection();

    const contextBuilder = new ContextBuilder({
      bootstrapFiles: [],
      memorySearch: { maxResults: 5, minLength: 10 },
      gatewaySkills: [],
      workspaceRoot: workspace,
      now: () => new Date(),
    });

    const result = contextBuilder.buildContext("hello", [], {
      sessionMemoryContext,
    });

    const allContent = result.messages.map((m) => m.content).join("\n");
    assert.ok(allContent.includes("Fixed all bugs"), "context should contain rolling summary");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("7. buildContext injects working-memory summary", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const smm = new SessionMemoryManager(sessionId, workspace);
    smm.applyPatch({
      goal: "Implement login feature",
      constraints: ["Must use OAuth2"],
      facts: ["User table has email column"],
    });

    const sessionMemoryContext = smm.buildWorkingMemorySummary();

    const contextBuilder = new ContextBuilder({
      bootstrapFiles: [],
      memorySearch: { maxResults: 5, minLength: 10 },
      gatewaySkills: [],
      workspaceRoot: workspace,
      now: () => new Date(),
    });

    const result = contextBuilder.buildContext("continue", [], {
      sessionMemoryContext,
    });

    const allContent = result.messages.map((m) => m.content).join("\n");
    assert.ok(allContent.includes("Implement login feature"), "should contain goal");
    assert.ok(allContent.includes("OAuth2"), "should contain constraint");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("8. ContextCompressor.extractSessionMemoryPatch extracts files and commands", () => {
  const messages = [
    { role: "user" as const, content: "fix the bug" },
    {
      role: "assistant" as const,
      content: JSON.stringify({
        toolName: "file.write",
        input: { path: "D:\\project\\src\\main.ts", content: "fixed" },
        status: "success",
      }),
    },
    {
      role: "assistant" as const,
      content: JSON.stringify({
        toolName: "shell.run",
        input: { command: "npm test" },
        status: "success",
      }),
    },
    {
      role: "assistant" as const,
      content: JSON.stringify({
        status: "failure",
        error: "Type error in foo.ts:42",
      }),
    },
  ];

  const patch = ContextCompressor.extractSessionMemoryPatch(messages);

  assert.ok(patch.filesTouched?.some((f) => f.includes("main.ts")), "should extract file path");
  assert.ok(patch.commandsRun?.includes("npm test"), "should extract command");
  assert.ok(patch.failures?.some((f) => f.includes("Type error")), "should extract failure");
});

test("9. patch persists across SessionMemoryManager instances", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const smm1 = new SessionMemoryManager(sessionId, workspace);
    smm1.applyPatch({
      goal: "Build the feature",
      facts: ["Database is PostgreSQL"],
    });

    const smm2 = new SessionMemoryManager(sessionId, workspace);
    const wm = smm2.readWorkingMemory();
    assert.equal(wm.sessionGoal, "Build the feature");
    assert.ok(wm.importantFacts.includes("Database is PostgreSQL"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("10. sensitive content is sanitized from working memory", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const smm = new SessionMemoryManager(sessionId, workspace);
    smm.applyPatch({
      facts: ["api_key=sk-1234567890abcdef1234567890abcdef"],
      constraints: ["password: mySecretPassword123"],
    });

    const wm = smm.readWorkingMemory();
    assert.ok(
      !wm.importantFacts.some((f) => f.includes("sk-1234567890abcdef")),
      "should not contain raw API key"
    );
    assert.ok(
      !wm.userConstraints.some((c) => c.includes("mySecretPassword123")),
      "should not contain raw password"
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("11. devTaskState and working-memory coexist", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    manager.setCurrentSessionDevTaskState({
      status: "running",
      fixRounds: 1,
      startedAt: new Date().toISOString(),
    });

    const smm = new SessionMemoryManager(sessionId, workspace);
    smm.applyPatch({
      goal: "Fix test failures",
      failures: ["AssertionError in test 3"],
    });

    const session = manager.getCurrentSession();
    assert.ok(session.devTaskState);
    assert.equal(session.devTaskState.status, "running");

    const wm = smm.readWorkingMemory();
    assert.equal(wm.sessionGoal, "Fix test failures");
    assert.ok(wm.lastKnownFailures.some((f) => f.includes("AssertionError")));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("12. open-issues.json and decisions.jsonl work correctly", () => {
  const workspace = createTempWorkspace();
  try {
    const manager = createSessionManager(workspace);
    const sessionId = manager.getCurrentSessionId();

    const smm = new SessionMemoryManager(sessionId, workspace);

    smm.applyPatch({
      issues: ["Type error in parser.ts", "Missing export in index.ts"],
    });

    const issues = smm.readOpenIssues();
    assert.equal(issues.length, 2);
    assert.ok(issues.some((i) => i.description.includes("parser.ts")));

    smm.appendDecision({
      decision: "Use zod for validation",
      reason: "Better TypeScript integration",
      timestamp: new Date().toISOString(),
    });

    const decisions = smm.readDecisions();
    assert.equal(decisions.length, 1);
    assert.ok(decisions[0].decision.includes("zod"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
