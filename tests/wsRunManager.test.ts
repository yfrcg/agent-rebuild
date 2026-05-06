
import assert from "node:assert/strict";
import test from "node:test";

import { RunManager } from "../packages/gateway/ws/runManager";

test("run manager creates runs", () => {
  const runs = new RunManager();
  const run = runs.createRun({ sessionId: "s1", requestId: "req1" });

  assert.equal(run.sessionId, "s1");
  assert.equal(run.requestId, "req1");
  assert.equal(run.status, "running");
  assert.equal(runs.getRun(run.runId), run);
});

test("run manager finishes runs", () => {
  const runs = new RunManager();
  const run = runs.createRun({ sessionId: "s1", requestId: "req1" });

  const finished = runs.finishRun(run.runId);
  assert.equal(finished?.status, "completed");
  assert.equal(typeof finished?.endedAt, "string");
});

test("run manager fails runs", () => {
  const runs = new RunManager();
  const run = runs.createRun({ sessionId: "s1", requestId: "req1" });

  const failed = runs.failRun(run.runId, "boom");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "boom");
});

test("run manager cancels runs", () => {
  const runs = new RunManager();
  const run = runs.createRun({ sessionId: "s1", requestId: "req1" });

  const cancelled = runs.cancelRun(run.runId);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.abortController.signal.aborted, true);
});

test("run manager lists runs by session", () => {
  const runs = new RunManager();
  runs.createRun({ sessionId: "s1", requestId: "req1" });
  runs.createRun({ sessionId: "s2", requestId: "req2" });

  assert.equal(runs.listRuns().length, 2);
  assert.equal(runs.listRuns("s1").length, 1);
});
