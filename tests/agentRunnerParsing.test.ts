import assert from "node:assert/strict";
import test from "node:test";

import {
  groundFinalResponseToToolEvidence,
  tryParseAgentModelOutput,
} from "../packages/gateway/agentRunner";

test("tryParseAgentModelOutput extracts first tool call from mixed structured output", () => {
  const raw = `
{"type":"tool_call","tool":"file.write","args":{"path":"HelloWorld.cpp","content":"#include <iostream>\\n"}}
[TOOL_CALL] {"type":"tool_call","tool":"shell.run","args":{"command":"g++ -o HelloWorld.exe HelloWorld.cpp && HelloWorld.exe","cwd":"D:\\\\WorkStation\\\\CoLab"}}
[TOOL_CALL] {"type":"final","content":""}
  `;

  const parsed = tryParseAgentModelOutput(raw);

  assert.deepEqual(parsed, {
    type: "tool_call",
    tool: "file.write",
    args: {
      path: "HelloWorld.cpp",
      content: "#include <iostream>\n",
    },
  });
});

test("tryParseAgentModelOutput handles think tags and fenced final JSON", () => {
  const raw = `
<think>internal reasoning</think>
\`\`\`json
{"type":"final","content":"done"}
\`\`\`
  `;

  const parsed = tryParseAgentModelOutput(raw);

  assert.deepEqual(parsed, {
    type: "final",
    content: "done",
  });
});

test("groundFinalResponseToToolEvidence rewrites unsupported success claims", () => {
  const grounded = groundFinalResponseToToolEvidence(
    "帮我设计一个打印杨辉三角的cpp程序",
    "已完成。测试结果如下，文件位置：D:\\WorkStation\\CoLab\\yanghui.cpp",
    [
      {
        id: "tool-1",
        toolName: "file.list",
        input: { path: "D:\\WorkStation\\CoLab" },
        status: "success",
        toolCall: { id: "tool-1", name: "file.list", args: { path: "D:\\WorkStation\\CoLab" } },
        createdAt: new Date().toISOString(),
      },
    ] as any
  );

  assert.equal(grounded.adjusted, true);
  assert.match(grounded.text, /不能确认|没有证据|file\.write/i);
  assert.match(grounded.text, /file\.list/i);
});

test("groundFinalResponseToToolEvidence accepts successful file.write evidence from tool result path", () => {
  const grounded = groundFinalResponseToToolEvidence(
    "帮我设计一个打印杨辉三角的cpp程序",
    "已创建 yanghui.cpp",
    [
      {
        id: "tool-1",
        toolName: "file.write",
        input: { path: "yanghui.cpp" },
        status: "success",
        toolCall: { id: "tool-1", name: "file.write", args: { path: "yanghui.cpp" } },
        result: {
          toolCallId: "tool-1",
          ok: true,
          result: { path: "yanghui.cpp" },
        },
        createdAt: new Date().toISOString(),
      },
    ] as any
  );

  assert.equal(grounded.adjusted, false);
  assert.equal(grounded.text, "已创建 yanghui.cpp");
});

test("groundFinalResponseToToolEvidence blocks JSON-shaped creation claims without file evidence", () => {
  const grounded = groundFinalResponseToToolEvidence(
    "帮我设计一个打印杨辉三角的cpp程序",
    JSON.stringify({
      code: 0,
      message: "文件创建成功",
      data: {
        filename: "yanghui.cpp",
        path: "D:\\WorkStation\\CoLab\\yanghui.cpp",
      },
    }),
    []
  );

  assert.equal(grounded.adjusted, true);
  assert.match(grounded.text, /没有证据|file\.write/i);
});
