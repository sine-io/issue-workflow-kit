import assert from "node:assert/strict";
import test from "node:test";

import { marker } from "../scripts/runtime-domain.mjs";
import {
  attemptComments,
  currentAttempt,
  labelsWithStatus,
  taskStatus,
  validateBlock,
  validateNote,
} from "../scripts/task-state.mjs";

test("task status helpers enforce one managed status label", () => {
  const issue = { number: 1, labels: [{ name: "type:task" }, { name: "status:ready" }, { name: "human" }] };
  assert.equal(taskStatus(issue), "ready");
  assert.deepEqual(labelsWithStatus(issue, "in-progress"), ["type:task", "human", "status:in-progress"]);
  assert.throws(() => taskStatus({ number: 2, labels: ["status:ready", "status:blocked"] }), /exactly one/);
});

test("attempt comments select the highest non-superseded attempt", () => {
  const values = [
    { attemptId: "TASK-A01", attempt: 1, status: "superseded" },
    { attemptId: "TASK-A02", attempt: 2, status: "in-progress" },
  ];
  const comments = values.map((value, index) => ({
    id: index + 1,
    created_at: `2026-07-23T00:00:0${index}Z`,
    body: marker("attempt", value),
  }));
  assert.equal(attemptComments(comments).length, 2);
  assert.equal(currentAttempt(comments).value.attemptId, "TASK-A02");
});

test("notes and block reasons reject local paths, secrets, and unknown kinds", () => {
  assert.equal(validateNote("still running"), "still running");
  assert.deepEqual(validateBlock("verification", "test failed"), { kind: "verification", reason: "test failed" });
  assert.throws(() => validateBlock("other", "reason"), /block kind/);
  assert.throws(() => validateNote("see /home/user/full.log"), /absolute path/);
  assert.throws(() => validateBlock("transient", "token ghp_123456"), /secret/);
});
