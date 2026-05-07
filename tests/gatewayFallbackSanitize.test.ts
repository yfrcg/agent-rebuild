import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeFallbackText } from "../packages/gateway/gateway";

test("sanitizeFallbackText removes tool-call residue from plain-text fallback", () => {
  const raw = `
[⚠ 工具未被调用 — 模型未按 JSON 格式返回工具调用]

[TOOL_CALL] {"type":"tool_call","tool":"shell.run","args":{"command":"type D:\\\\WorkStation\\\\CoLab\\\\yanghui.cpp","cwd":"D:\\\\WorkStation\\\\CoLab"}}
[TOOL_CALL] {"type":"tool_call","tool":"shell.run","args":{"command":"g++ -o yanghui.exe yanghui.cpp && yanghui.exe","cwd":"D:\\\\WorkStation\\\\CoLab"}}
`;

  assert.equal(sanitizeFallbackText(raw), "");
});

test("sanitizeFallbackText prefers final content when final JSON is present", () => {
  const raw = `
[TOOL_CALL] {"type":"tool_call","tool":"file.write","args":{"path":"hello.cpp","content":"#include <iostream>\\n"}}
{"type":"final","content":"已创建 hello.cpp"}
`;

  assert.equal(sanitizeFallbackText(raw), "已创建 hello.cpp");
});

test("sanitizeFallbackText strips tool result blocks", () => {
  const raw = `
[Tool Result] tool=shell.run
args={"command":"dir yanghui.cpp","cwd":"D:\\\\WorkStation\\\\CoLab"}
[/Tool Result]
`;

  assert.equal(sanitizeFallbackText(raw), "");
});
