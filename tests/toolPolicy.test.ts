import test from "node:test";
import assert from "node:assert/strict";

import { createBuiltinToolRegistry } from "../packages/gateway/builtinTools";

test("builtin memory.search tool is marked as safe auto-read", () => {
  const registry = createBuiltinToolRegistry({
    memorySearch: async () => [],
  });

  const tool = registry.get("memory.search");

  assert.ok(tool);
  assert.equal(tool?.policy?.automationLevel, "auto");
  assert.equal(tool?.policy?.riskLevel, "read-only");
  assert.equal(tool?.security?.riskLevel, "safe");

  const listed = registry.list().find((item) => item.name === "memory.search");
  assert.equal(listed?.policy?.automationLevel, "auto");
});

test("builtin bash.run tool requires sandbox and forbids host execution", () => {
  const registry = createBuiltinToolRegistry({
    memorySearch: async () => [],
  });

  const tool = registry.get("bash.run");

  assert.ok(tool);
  assert.equal(tool?.security?.riskLevel, "medium");
  assert.equal(tool?.security?.sandboxRequired, true);
  assert.equal(tool?.security?.allowNetwork, false);
  assert.equal(tool?.security?.allowWrite, true);
  assert.equal(tool?.security?.allowHostExecution, false);
  assert.equal(tool?.security?.requireApproval, false);
  assert.equal(typeof tool?.sandboxSpec?.resolve, "function");
});

test("builtin file.read tool is sandboxed and forbids host execution", () => {
  const registry = createBuiltinToolRegistry({
    memorySearch: async () => [],
  });

  const tool = registry.get("file.read");

  assert.ok(tool);
  assert.equal(tool?.policy?.riskLevel, "read-only");
  assert.equal(tool?.security?.sandboxRequired, true);
  assert.equal(tool?.security?.allowHostExecution, false);
  assert.equal(typeof tool?.sandboxSpec?.resolve, "function");
});

test("builtin execution tools require sandbox execution", () => {
  const registry = createBuiltinToolRegistry({
    memorySearch: async () => [],
  });

  for (const toolName of ["run_test", "npm_test", "build"] as const) {
    const tool = registry.get(toolName);
    assert.ok(tool, `${toolName} should be registered`);
    assert.equal(tool?.permissionLevel, "execute");
    assert.equal(tool?.requiresSandbox, true);
    assert.equal(tool?.security?.sandboxRequired, true);
    assert.equal(typeof tool?.sandboxSpec?.resolve, "function");
  }
});
