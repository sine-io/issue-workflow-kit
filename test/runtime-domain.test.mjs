import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  acceptanceRunId,
  attemptIdFor,
  canTransitionTaskStatus,
  createExecutionEnvelope,
  defaultBranch,
  envelopeDigest,
  isAllowedPath,
  marker,
  parseMarker,
  runtimeDigest,
  verificationRunId,
} from "../scripts/runtime-domain.mjs";
import { approvalDigest } from "../scripts/plan-validation.mjs";

const sourcePlan = JSON.parse(fs.readFileSync(new URL("../examples/issue-plan.v1.1.example.json", import.meta.url), "utf8"));

function approvedPlan() {
  const plan = structuredClone(sourcePlan);
  plan.approval = {
    status: "approved",
    digest: approvalDigest(plan),
    approvedAt: "2026-07-23T00:00:00Z",
    approvedBy: "reviewer",
  };
  return plan;
}

function envelope() {
  const plan = approvedPlan();
  return createExecutionEnvelope({
    plan,
    record: plan.epics[0].tasks[0],
    issue: { number: 42, html_url: "https://example.test/issues/42" },
    attempt: 1,
    agent: "example-agent",
  });
}

test("execution envelope derives stable IDs, defaults, branch, and digest", () => {
  const value = envelope();
  assert.equal(value.attemptId, "DEMO-20260723-T01-A01");
  assert.equal(value.branch, "iwf/demo-20260723-t01-a1");
  assert.equal(value.acceptance[0].id, "DEMO-20260723-T01-AC01");
  assert.equal(value.verification[0].id, "DEMO-20260723-T01-V01");
  assert.equal(envelopeDigest(value), runtimeDigest(structuredClone(value)));
  assert.equal(attemptIdFor(value.taskId, 12), "DEMO-20260723-T01-A12");
  assert.equal(acceptanceRunId(value.taskId, 2), "DEMO-20260723-T01-AC02");
  assert.equal(verificationRunId(value.taskId, 2), "DEMO-20260723-T01-V02");
  assert.equal(defaultBranch(value.taskId, 2), "iwf/demo-20260723-t01-a2");
});

test("runtime markers are canonical, stable, and parseable", () => {
  const payload = { z: 1, a: { y: 2, x: 3 } };
  const rendered = marker("attempt", payload);
  assert.equal(rendered, marker("attempt", structuredClone(payload)));
  assert.deepEqual(parseMarker(rendered, "attempt"), { a: { x: 3, y: 2 }, z: 1 });
  assert.equal(parseMarker("human comment", "attempt"), null);
  assert.throws(() => parseMarker("<!-- issue-workflow-attempt:v1 {bad} -->", "attempt"), /invalid attempt marker/);
});

test("allowed path matching accepts exact paths and directory prefixes only", () => {
  assert.equal(isAllowedPath("scripts/task-runtime.mjs", ["scripts/**"]), true);
  assert.equal(isAllowedPath("README.md", ["README.md"]), true);
  assert.equal(isAllowedPath("README.md.bak", ["README.md"]), false);
  assert.equal(isAllowedPath("../secret", ["scripts/**"]), false);
  assert.equal(isAllowedPath("scripts\\secret", ["scripts/**"]), false);
});

test("task state transitions follow the declared lifecycle", () => {
  assert.equal(canTransitionTaskStatus("backlog", "ready"), true);
  assert.equal(canTransitionTaskStatus("ready", "in-progress"), true);
  assert.equal(canTransitionTaskStatus("in-progress", "blocked"), true);
  assert.equal(canTransitionTaskStatus("blocked", "in-progress"), true);
  assert.equal(canTransitionTaskStatus("in-progress", "closed"), false);
});

export { approvedPlan, envelope };
