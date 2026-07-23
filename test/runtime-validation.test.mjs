import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createCompletionResult, createExecutionEnvelope } from "../scripts/runtime-domain.mjs";
import { approvalDigest } from "../scripts/plan-validation.mjs";
import { validateCompletionResult, validateExecutionEnvelope } from "../scripts/runtime-validation.mjs";

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

function makeEnvelope() {
  const plan = approvedPlan();
  return createExecutionEnvelope({
    plan,
    record: plan.epics[0].tasks[0],
    issue: { number: 42, html_url: "https://example.test/issues/42" },
    agent: "example-agent",
  });
}

function successEvidence(envelope) {
  return {
    acceptance: envelope.acceptance.map((run) => ({ id: run.id, status: "success", evidence: ["Reviewed output"] })),
    verification: envelope.verification.map((run) => ({ id: run.id, status: "success", evidence: ["Command exited 0"] })),
  };
}

test("execution and completion records pass strict validation", () => {
  const plan = approvedPlan();
  const envelope = makeEnvelope();
  const task = plan.epics[0].tasks[0];
  const execution = validateExecutionEnvelope(envelope, { plan, task });
  const evidence = successEvidence(envelope);
  const completion = createCompletionResult({
    envelope,
    result: "success",
    ...evidence,
    artifacts: [{ url: "https://example.test/runs/1", summary: "Test run", sha256: "a".repeat(64) }],
  });
  const validated = validateCompletionResult(completion, { envelope, plan, task });
  assert.equal(completion.envelopeDigest, execution.digest);
  assert.equal(validated.digest.length, 64);
});

test("runtime validation rejects unknown fields, tampering, and cross-attempt evidence", () => {
  const plan = approvedPlan();
  const task = plan.epics[0].tasks[0];
  const envelope = makeEnvelope();

  const unknown = structuredClone(envelope);
  unknown.secret = "value";
  assert.throws(() => validateExecutionEnvelope(unknown, { plan, task }), /additional propert/i);

  const invalidPath = structuredClone(envelope);
  invalidPath.allowedPaths = ["../outside"];
  assert.throws(() => validateExecutionEnvelope(invalidPath, { plan, task }), /schema validation|invalid allowedPath/);

  const evidence = successEvidence(envelope);
  const completion = createCompletionResult({ envelope, result: "success", ...evidence });
  completion.envelopeDigest = "0".repeat(64);
  assert.throws(() => validateCompletionResult(completion, { envelope, plan, task }), /envelopeDigest/);

  completion.envelopeDigest = validateExecutionEnvelope(envelope, { plan, task }).digest;
  completion.attemptId = `${task.id}-A02`;
  assert.throws(() => validateCompletionResult(completion, { envelope, plan, task }), /attemptId/);
});

test("completion requires complete, unique evidence and safe artifact URLs", () => {
  const plan = approvedPlan();
  const task = plan.epics[0].tasks[0];
  const envelope = makeEnvelope();
  const evidence = successEvidence(envelope);

  const missing = createCompletionResult({ envelope, result: "success", ...evidence });
  missing.verification = [];
  assert.throws(() => validateCompletionResult(missing, { envelope, plan, task }), /fewer than 1 items|missing verification/);

  const duplicate = createCompletionResult({ envelope, result: "success", ...evidence });
  duplicate.acceptance.push({ ...duplicate.acceptance[0], evidence: ["another"] });
  assert.throws(() => validateCompletionResult(duplicate, { envelope, plan, task }), /unique/);

  const localArtifact = createCompletionResult({
    envelope,
    result: "success",
    ...evidence,
    artifacts: [{ url: "file:///tmp/full.log", summary: "Local log" }],
  });
  assert.throws(() => validateCompletionResult(localArtifact, { envelope, plan, task }), /format/);
});
