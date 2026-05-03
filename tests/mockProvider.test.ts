import test from "node:test";
import assert from "node:assert/strict";

import { MockModelProvider } from "../packages/model/mockProvider";

test("MockModelProvider returns stable text from the last user message", async () => {
  const provider = new MockModelProvider();
  const response = await provider.generate([
    { role: "system", content: "system prompt" },
    { role: "user", content: "first user message" },
    { role: "assistant", content: "assistant reply" },
    { role: "user", content: "latest user message" },
  ]);

  assert.equal(provider.name, "mock");
  assert.match(response.text, /latest user message/);
});
