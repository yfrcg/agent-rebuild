/**
 * ?????CS336 ???
 * ???tests/agent.test.ts
 * ????????
 * ?????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe } from "node:test";

import {
  groundFinalResponseToToolEvidence,
  tryParseAgentModelOutput,
  AgentRunner,
} from "../packages/gateway/agentRunner";
import { createBuiltinToolRegistry } from "../packages/gateway/builtinTools";
import { createGatewayRequest } from "../packages/gateway/requestHandler";
import { ToolCallExecutor } from "../packages/gateway/toolCallExecutor";
import type { ChatMessage, ModelProvider, ModelResponse } from "../packages/model/types";

class SequenceModelProvider implements ModelProvider {
  readonly name = "mock-sequence";
  constructor(private readonly responses: string[]) {}
  async generate(_messages: ChatMessage[]): Promise<ModelResponse> {
    const text = this.responses.shift();
    if (text === undefined) throw new Error("No mock response queued");
    return { text };
  }
}

describe("agent runner parsing", () => {
  test("extracts first tool call from mixed structured output", () => {
    const raw = `
{"type":"tool_call","tool":"file.write","args":{"path":"HelloWorld.cpp","content":"#include <iostream>\\n"}}
[TOOL_CALL] {"type":"tool_call","tool":"shell.run","args":{"command":"g++ -o HelloWorld.exe HelloWorld.cpp && HelloWorld.exe","cwd":"D:\\\\WorkStation\\\\CoLab"}}
[TOOL_CALL] {"type":"final","content":""}
    `;
    const parsed = tryParseAgentModelOutput(raw);
    assert.deepEqual(parsed, {
      type: "tool_call",
      tool: "file.write",
      args: { path: "HelloWorld.cpp", content: "#include <iostream>\n" },
    });
  });

  test("handles think tags and fenced final JSON", () => {
    const raw = `
<think>internal reasoning</think>
\`\`\`json
{"type":"final","content":"done"}
\`\`\`
    `;
    const parsed = tryParseAgentModelOutput(raw);
    assert.deepEqual(parsed, { type: "final", content: "done" });
  });

  test("groundFinalResponse rewrites unsupported success claims", () => {
    const grounded = groundFinalResponseToToolEvidence(
      "帮我设计一个打印杨辉三角的cpp程序",
      "已完成。测试结果如下，文件位置：D:\\WorkStation\\CoLab\\yanghui.cpp",
      [{ id: "tool-1", toolName: "file.list", input: { path: "D:\\WorkStation\\CoLab" }, status: "success", toolCall: { id: "tool-1", name: "file.list", args: { path: "D:\\WorkStation\\CoLab" } }, createdAt: new Date().toISOString() }] as any
    );
    assert.equal(grounded.adjusted, true);
    assert.match(grounded.text, /不能确认|没有证据|file\.write/i);
    assert.match(grounded.text, /file\.list/i);
  });

  test("groundFinalResponse accepts successful file.write evidence", () => {
    const grounded = groundFinalResponseToToolEvidence(
      "帮我设计一个打印杨辉三角的cpp程序",
      "已创建 yanghui.cpp",
      [{ id: "tool-1", toolName: "file.write", input: { path: "yanghui.cpp" }, status: "success", toolCall: { id: "tool-1", name: "file.write", args: { path: "yanghui.cpp" } }, result: { toolCallId: "tool-1", ok: true, result: { path: "yanghui.cpp" } }, createdAt: new Date().toISOString() }] as any
    );
    assert.equal(grounded.adjusted, false);
    assert.equal(grounded.text, "已创建 yanghui.cpp");
  });

  test("groundFinalResponse blocks JSON-shaped creation claims without file evidence", () => {
    const grounded = groundFinalResponseToToolEvidence(
      "帮我设计一个打印杨辉三角的cpp程序",
      JSON.stringify({ code: 0, message: "文件创建成功", data: { filename: "yanghui.cpp", path: "D:\\WorkStation\\CoLab\\yanghui.cpp" } }),
      []
    );
    assert.equal(grounded.adjusted, true);
    assert.match(grounded.text, /没有证据|file\.write/i);
  });
});

describe("agent runner execution", () => {
  test("executes file.write from mixed plain-text tool-call output", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-write-"));
    const projectDir = path.join(workspace, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    try {
      const registry = createBuiltinToolRegistry({ memorySearch: async () => [], projectRoot: workspace });
      const executor = new ToolCallExecutor({ registry, projectRoot: workspace, allowBypassPermissions: true });
      const provider = new SequenceModelProvider([
        ['[⚠️ 工具未被调用 — 模型未按 JSON 格式返回工具调用]', "", '{"type":"tool_call","tool":"file.write","args":{"path":"yanghui.cpp","content":"#include <iostream>\\nint main() { std::cout << 1 << std::endl; return 0; }\\n"}}', '[TOOL_CALL] {"type":"final","content":""}'].join("\n"),
        '{"type":"final","content":"已创建 D:\\\\WorkStation\\\\CoLab\\\\yanghui.cpp"}',
      ]);
      const runner = new AgentRunner({ modelProvider: provider, memorySearch: async () => [], toolRegistry: registry, toolCallExecutor: executor, maxToolCalls: 2 });
      const result = await runner.run(createGatewayRequest("帮我设计一个打印杨辉三角的cpp程序", {
        permissionMode: "bypassPermissions",
        projectBoundary: { projectDir, permission: "project-write", allowedReadRoots: [projectDir], allowedWriteRoots: [projectDir], commandCwd: projectDir },
      }));
      const filePath = path.join(projectDir, "yanghui.cpp");
      assert.equal(fs.existsSync(filePath), true);
      assert.match(fs.readFileSync(filePath, "utf8"), /#include <iostream>/);
      assert.equal(result.toolCalls.some((tc) => tc.toolName === "file.write" && tc.status === "success"), true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("keeps going after unsupported final and eventually writes the file", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-retry-"));
    const projectDir = path.join(workspace, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    try {
      const registry = createBuiltinToolRegistry({ memorySearch: async () => [], projectRoot: workspace });
      const executor = new ToolCallExecutor({ registry, projectRoot: workspace, allowBypassPermissions: true });
      const provider = new SequenceModelProvider([
        '{"type":"tool_call","tool":"file.list","args":{"path":"' + projectDir.replace(/\\/g, "\\\\") + '"}}',
        '{"type":"final","content":"已完成。文件位置：D:\\\\WorkStation\\\\CoLab\\\\yanghui.cpp"}',
        '{"type":"tool_call","tool":"file.write","args":{"path":"yanghui.cpp","content":"#include <iostream>\\nint main() { std::cout << 1 << std::endl; return 0; }\\n"}}',
        '{"type":"final","content":"已创建 yanghui.cpp"}',
      ]);
      const runner = new AgentRunner({ modelProvider: provider, memorySearch: async () => [], toolRegistry: registry, toolCallExecutor: executor, maxToolCalls: 3 });
      const result = await runner.run(createGatewayRequest("帮我设计一个打印杨辉三角的cpp程序", {
        permissionMode: "bypassPermissions",
        projectBoundary: { projectDir, permission: "project-write", allowedReadRoots: [projectDir], allowedWriteRoots: [projectDir], commandCwd: projectDir },
      }));
      const filePath = path.join(projectDir, "yanghui.cpp");
      assert.equal(fs.existsSync(filePath), true);
      assert.equal(result.toolCalls.some((tc) => tc.toolName === "file.write" && tc.status === "success"), true);
      assert.match(result.text, /yanghui\.cpp/i);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
