import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  approvalDigest,
  canonicalize,
  validatePlan,
} from "../scripts/plan-validation.mjs";

const example = JSON.parse(fs.readFileSync(new URL("../examples/issue-plan.example.json", import.meta.url), "utf8"));
const v11Example = JSON.parse(fs.readFileSync(new URL("../examples/issue-plan.v1.1.example.json", import.meta.url), "utf8"));

test("valid example passes strict schema and semantic validation", () => {
  const result = validatePlan(example);
  assert.equal(result.plan.plan.id, "DEMO-20260722");
  assert.equal(result.digest, approvalDigest(example));
});

test("v1.1 example dispatches to the versioned schema", () => {
  const result = validatePlan(v11Example);
  assert.equal(result.plan.schemaVersion, "1.1");
  assert.equal(result.plan.epics[0].execution.commitPolicy, "required");
  assert.equal(result.digest, approvalDigest(v11Example));
});

test("v1.1 rejects invalid metadata, execution policy, dates, and schema paths", () => {
  const invalidDate = structuredClone(v11Example);
  invalidDate.epics[0].management.dueDate = "2026-02-30";
  assert.throws(() => validatePlan(invalidDate), /invalid dueDate/);

  const unknown = structuredClone(v11Example);
  unknown.epics[0].management.unknown = true;
  assert.throws(() => validatePlan(unknown), /additional propert/i);

  const unknownTask = structuredClone(v11Example);
  unknownTask.epics[0].tasks[0].unknown = true;
  assert.throws(() => validatePlan(unknownTask), /unevaluated propert/i);

  const policy = structuredClone(v11Example);
  policy.epics[0].execution.commitPolicy = "optional";
  assert.throws(() => validatePlan(policy), /must be equal to constant/);

  const checks = structuredClone(v11Example);
  checks.epics[0].execution.requiredChecks = [];
  assert.throws(() => validatePlan(checks), /fewer than 1 items/);

  const pathMismatch = structuredClone(v11Example);
  pathMismatch.$schema = "../.github/issue-plan.schema.json";
  assert.throws(() => validatePlan(pathMismatch), /schema path/);

  const untrustedSchema = structuredClone(v11Example);
  untrustedSchema.$schema = "https://example.test/issue-plan.v1.1.schema.json";
  assert.throws(() => validatePlan(untrustedSchema), /schema URL/);
});

test("canonicalization sorts object keys but preserves array order", () => {
  assert.deepEqual(canonicalize({ z: 1, a: { y: 2, x: 3 }, list: ["b", "a"] }), {
    a: { x: 3, y: 2 }, list: ["b", "a"], z: 1,
  });
});

test("unknown fields and empty acceptance are rejected", () => {
  const unknown = structuredClone(example);
  unknown.extra = true;
  assert.throws(() => validatePlan(unknown), /additional propert/i);

  const empty = structuredClone(example);
  empty.epics[0].tasks[0].acceptanceCriteria = [];
  assert.throws(() => validatePlan(empty), /fewer than 1 items/);
});

test("duplicate IDs, missing dependencies, and cycles are rejected", () => {
  const duplicate = structuredClone(example);
  duplicate.epics[0].tasks.push(structuredClone(duplicate.epics[0].tasks[0]));
  assert.throws(() => validatePlan(duplicate), /duplicate ID/);

  const missing = structuredClone(example);
  missing.epics[0].tasks[0].dependsOn = ["MISSING-1"];
  assert.throws(() => validatePlan(missing), /unknown dependency/);

  const cycle = structuredClone(example);
  cycle.epics[0].tasks.push({
    ...structuredClone(cycle.epics[0].tasks[0]),
    id: "DEMO-20260722-T02",
    dependsOn: ["DEMO-20260722-T01"],
  });
  cycle.epics[0].tasks[0].dependsOn = ["DEMO-20260722-T02"];
  assert.throws(() => validatePlan(cycle), /cycle/);
});

test("approved content must carry the exact digest", () => {
  const approved = structuredClone(example);
  approved.approval = {
    status: "approved",
    digest: approvalDigest(approved),
    approvedAt: "2026-07-22T00:00:00Z",
    approvedBy: "reviewer",
  };
  assert.doesNotThrow(() => validatePlan(approved, { requireApproval: true }));
  approved.epics[0].tasks[0].title = "Changed after approval";
  assert.throws(() => validatePlan(approved, { requireApproval: true }), /digest mismatch/);
});

test("the repository's approved implementation plan is valid", () => {
  const plan = JSON.parse(fs.readFileSync(new URL("../.github/issue-plans/IWF-20260722.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validatePlan(plan, { requireApproval: true }));
});

test("the repository's approved v1.0 runtime launch plan remains valid", () => {
  const plan = JSON.parse(fs.readFileSync(new URL("../.github/issue-plans/IWF-20260723.json", import.meta.url), "utf8"));
  const result = validatePlan(plan, { requireApproval: true });
  assert.equal(result.plan.schemaVersion, "1.0");
  assert.equal(result.plan.approval.status, "approved");
  assert.equal(result.plan.approval.digest, "5e0c07c1ba6728857bcd734d8ad539548d63c70e277806d8b3a4d8cc4c725374");
  assert.equal(result.plan.epics[0].tasks.length, 9);
});
