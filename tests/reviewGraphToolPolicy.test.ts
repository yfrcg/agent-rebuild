import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkToolPolicy } from "../packages/gateway/reviewGraph/toolPolicy";
import type { AgentDefinition, ReviewGraphState } from "../packages/gateway/reviewGraph/types";

function makeAgentDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "TestAgent",
    node: "explore",
    systemPrompt: "test",
    allowedTools: ["file.read", "file.glob", "file.grep", "file.list", "git.status"],
    deniedTools: ["file.write", "file.edit", "shell.run"],
    canSpawnAgents: false,
    maxToolCalls: 10,
    ...overrides,
  };
}

function makeState(overrides: Partial<ReviewGraphState> = {}): ReviewGraphState {
  return {
    runId: "test_run_001",
    userGoal: "test goal",
    taskType: "feature",
    currentNode: "explore",
    targetFiles: [],
    constraints: [],
    repairRounds: 0,
    maxRepairRounds: 3,
    auditRefs: [],
    startTime: Date.now(),
    ...overrides,
  };
}

const WORKSPACE = process.cwd();

describe("reviewGraph checkToolPolicy", () => {
  describe("allowedTools", () => {
    it("allows tool in allowedTools list", () => {
      const result = checkToolPolicy({
        agentDef: makeAgentDef(),
        toolName: "file.read",
        args: { path: "src/index.ts" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.violations.length, 0);
    });

    it("allows all listed tools", () => {
      const agentDef = makeAgentDef({
        allowedTools: ["file.read", "file.glob", "git.status"],
      });
      for (const tool of ["file.read", "file.glob", "git.status"]) {
        const result = checkToolPolicy({
          agentDef,
          toolName: tool,
          args: {},
          state: makeState(),
          workspaceRoot: WORKSPACE,
        });
        assert.equal(result.allowed, true, `${tool} should be allowed`);
      }
    });
  });

  describe("deniedTools", () => {
    it("denies tool in deniedTools list", () => {
      const result = checkToolPolicy({
        agentDef: makeAgentDef(),
        toolName: "file.write",
        args: { path: "src/index.ts", content: "x" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "denied_tool");
      assert.ok(result.violations[0].includes("file.write"));
    });

    it("denies shell.run", () => {
      const result = checkToolPolicy({
        agentDef: makeAgentDef(),
        toolName: "shell.run",
        args: { command: "echo hello" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "denied_tool");
    });
  });

  describe("non-allowedTools", () => {
    it("denies tool not in allowedTools", () => {
      const result = checkToolPolicy({
        agentDef: makeAgentDef(),
        toolName: "web.fetch",
        args: { url: "https://example.com" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "not_allowed_tool");
    });

    it("denies unknown tool", () => {
      const result = checkToolPolicy({
        agentDef: makeAgentDef(),
        toolName: "unknown.tool",
        args: {},
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "not_allowed_tool");
    });
  });

  describe("canSpawnAgents", () => {
    it("denies agent.spawn when canSpawnAgents=false", () => {
      const result = checkToolPolicy({
        agentDef: makeAgentDef({ allowedTools: ["agent.spawn"], canSpawnAgents: false }),
        toolName: "agent.spawn",
        args: {},
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "spawn_disabled");
    });
  });

  describe("Implement targetFiles restriction", () => {
    it("denies Implement Agent modifying non-target file", () => {
      const agentDef = makeAgentDef({
        node: "implement",
        allowedTools: ["file.write", "file.edit"],
        deniedTools: [],
      });
      const state = makeState({ targetFiles: ["src/a.ts"] });

      const result = checkToolPolicy({
        agentDef,
        toolName: "file.write",
        args: { path: "src/b.ts", content: "x" },
        state,
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "target_file_violation");
    });

    it("allows Implement Agent modifying target file", () => {
      const agentDef = makeAgentDef({
        node: "implement",
        allowedTools: ["file.write", "file.edit"],
        deniedTools: [],
      });
      const state = makeState({ targetFiles: ["src/a.ts"] });

      const result = checkToolPolicy({
        agentDef,
        toolName: "file.write",
        args: { path: "src/a.ts", content: "x" },
        state,
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, true);
    });

    it("allows when targetFiles is empty (no restriction)", () => {
      const agentDef = makeAgentDef({
        node: "implement",
        allowedTools: ["file.write"],
        deniedTools: [],
      });
      const state = makeState({ targetFiles: [] });

      const result = checkToolPolicy({
        agentDef,
        toolName: "file.write",
        args: { path: "src/anything.ts", content: "x" },
        state,
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, true);
    });
  });

  describe("sensitive file check", () => {
    it("denies access to .env file", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { path: ".env" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "sensitive_file");
    });

    it("denies access to .env.local", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { path: ".env.local" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "sensitive_file");
    });

    it("denies access to .ssh directory", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { path: "/home/user/.ssh/config" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "sensitive_file");
    });

    it("denies access to id_rsa", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { path: "/home/user/.ssh/id_rsa" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "sensitive_file");
    });

    it("denies access to id_ed25519", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { path: "id_ed25519" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "sensitive_file");
    });

    it("denies access to private.key", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { path: "certs/private.key" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "sensitive_file");
    });

    it("denies access to .npmrc", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { path: ".npmrc" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "sensitive_file");
    });

    it("allows access to normal files", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { path: "src/index.ts" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, true);
    });
  });

  describe("path escape check", () => {
    it("denies path traversal outside workspace", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { path: "../../etc/passwd" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "path_escape");
    });
  });

  describe("dangerous command check", () => {
    it("denies rm -rf", () => {
      const agentDef = makeAgentDef({
        allowedTools: ["shell.run"],
        deniedTools: [],
      });
      const result = checkToolPolicy({
        agentDef,
        toolName: "shell.run",
        args: { command: "rm -rf /" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "dangerous_command");
    });

    it("denies sudo", () => {
      const agentDef = makeAgentDef({
        allowedTools: ["shell.run"],
        deniedTools: [],
      });
      const result = checkToolPolicy({
        agentDef,
        toolName: "shell.run",
        args: { command: "sudo apt install something" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "dangerous_command");
    });

    it("denies git push via shell", () => {
      const agentDef = makeAgentDef({
        allowedTools: ["shell.run"],
        deniedTools: [],
      });
      const result = checkToolPolicy({
        agentDef,
        toolName: "shell.run",
        args: { command: "git push origin main" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "dangerous_command");
    });

    it("denies git reset --hard", () => {
      const agentDef = makeAgentDef({
        allowedTools: ["shell.run"],
        deniedTools: [],
      });
      const result = checkToolPolicy({
        agentDef,
        toolName: "shell.run",
        args: { command: "git reset --hard HEAD~1" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "dangerous_command");
    });

    it("denies npm publish", () => {
      const agentDef = makeAgentDef({
        allowedTools: ["shell.run"],
        deniedTools: [],
      });
      const result = checkToolPolicy({
        agentDef,
        toolName: "shell.run",
        args: { command: "npm publish" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "dangerous_command");
    });

    it("denies Invoke-Expression", () => {
      const agentDef = makeAgentDef({
        allowedTools: ["shell.run"],
        deniedTools: [],
      });
      const result = checkToolPolicy({
        agentDef,
        toolName: "shell.run",
        args: { command: "Invoke-Expression $cmd" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "dangerous_command");
    });

    it("allows safe shell commands", () => {
      const agentDef = makeAgentDef({
        allowedTools: ["shell.run"],
        deniedTools: [],
      });
      const result = checkToolPolicy({
        agentDef,
        toolName: "shell.run",
        args: { command: "npm test" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, true);
    });
  });

  describe("delete operation check", () => {
    it("denies file.delete tool", () => {
      const agentDef = makeAgentDef({
        allowedTools: ["file.delete"],
        deniedTools: [],
      });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.delete",
        args: { path: "src/old.ts" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "delete_operation");
    });

    it("denies rm in shell command", () => {
      const agentDef = makeAgentDef({
        allowedTools: ["shell.run"],
        deniedTools: [],
      });
      const result = checkToolPolicy({
        agentDef,
        toolName: "shell.run",
        args: { command: "rm tmp.txt" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "delete_operation");
    });
  });

  describe("git push check", () => {
    it("denies git push via shell.run", () => {
      const agentDef = makeAgentDef({
        allowedTools: ["shell.run"],
        deniedTools: [],
      });
      const result = checkToolPolicy({
        agentDef,
        toolName: "shell.run",
        args: { command: "git push origin main" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
    });
  });

  describe("multiple args path extraction", () => {
    it("extracts filePath from args", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { filePath: ".env" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "sensitive_file");
    });

    it("extracts file from args", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { file: "id_rsa" },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "sensitive_file");
    });

    it("extracts paths array from args", () => {
      const agentDef = makeAgentDef({ allowedTools: ["file.read"], deniedTools: [] });
      const result = checkToolPolicy({
        agentDef,
        toolName: "file.read",
        args: { paths: ["src/a.ts", ".env"] },
        state: makeState(),
        workspaceRoot: WORKSPACE,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "sensitive_file");
    });
  });
});
