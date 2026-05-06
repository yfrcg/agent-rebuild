
import test from "node:test";
import assert from "node:assert/strict";

import type { TranscriptEntry } from "../packages/core/src/types";
import { summarizeTranscriptForMemory } from "../packages/session/src/summary";

test("summarizeTranscriptForMemory extracts durable user facts and tasks", () => {
  const transcript: TranscriptEntry[] = [
    {
      id: "1",
      role: "user",
      content: "记住：我喜欢把 Gateway 做成离线优先。",
      createdAt: new Date().toISOString(),
    },
    {
      id: "2",
      role: "assistant",
      content: "好的，我会记住这个偏好。",
      createdAt: new Date().toISOString(),
    },
    {
      id: "3",
      role: "user",
      content: "接下来要做自动工具调用质量评测。",
      createdAt: new Date().toISOString(),
    },
  ];

  const summary = summarizeTranscriptForMemory(transcript, {
    prefix: "[test summary]",
  });

  assert.equal(summary.targetHint, "long-term");
  assert.match(summary.text, /User Facts:/);
  assert.match(summary.text, /Tasks:/);
  assert.match(summary.text, /离线优先/);
  assert.match(summary.text, /自动工具调用质量评测/);
});
