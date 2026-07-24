import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { approvalDigest, validatePlan } from "../scripts/plan-validation.mjs";
import {
  parseBehaviorContract,
  sha256Text,
  validateV2Plan,
  v2PlanDigest,
} from "../scripts/v2-plan.mjs";

const planUrl = new URL("../examples/issue-plan.v2.example.json", import.meta.url);
const contractUrl = new URL("../examples/behavior-contract.v2.example.md", import.meta.url);
const sourcePlan = JSON.parse(fs.readFileSync(planUrl, "utf8"));
const contract = fs.readFileSync(contractUrl, "utf8");

test("v2 plan binds the behavior contract and all immutable execution inputs", () => {
  const result = validateV2Plan(sourcePlan, { sourcePath: planUrl.pathname });
  assert.deepEqual(result.requirementIds, ["REQ-001", "REQ-002"]);
  assert.equal(result.contractDigest, sha256Text(contract));
  assert.equal(result.digest, v2PlanDigest(sourcePlan));
  assert.equal(result.digest, approvalDigest(sourcePlan));
  assert.equal(validatePlan(sourcePlan, { sourcePath: planUrl.pathname }).digest, result.digest);

  const changedModel = structuredClone(sourcePlan);
  changedModel.runner.model = "different-model";
  assert.notEqual(v2PlanDigest(changedModel), result.digest);
  const changedBase = structuredClone(sourcePlan);
  changedBase.plan.baseRevision = "a".repeat(40);
  assert.notEqual(v2PlanDigest(changedBase), result.digest);
});

test("approved v2 plan requires the exact immutable digest", () => {
  const approved = structuredClone(sourcePlan);
  approved.approval = {
    status: "approved",
    digest: v2PlanDigest(approved),
    approvedAt: "2026-07-24T00:00:00Z",
    approvedBy: "reviewer",
  };
  assert.doesNotThrow(() => validateV2Plan(approved, {
    sourcePath: planUrl.pathname,
    requireApproval: true,
  }));
  approved.epics[0].tasks[0].allowedPaths.push("README.md");
  assert.throws(() => validateV2Plan(approved, { sourcePath: planUrl.pathname, requireApproval: true }), /digest mismatch/);
});

test("v2 plan rejects contract drift and incomplete traceability", () => {
  assert.throws(() => validateV2Plan(sourcePlan, {
    sourcePath: planUrl.pathname,
    contractSource: `${contract}\nchanged\n`,
  }), /contract digest mismatch/);

  const unknownRequirement = structuredClone(sourcePlan);
  unknownRequirement.epics[0].tasks[0].requirementIds = ["REQ-999"];
  assert.throws(() => validateV2Plan(unknownRequirement, { sourcePath: planUrl.pathname }), /unknown requirement/);

  const rewrittenBoundary = structuredClone(sourcePlan);
  rewrittenBoundary.requirements[0].boundaries[0] = "A different machine-only boundary.";
  assert.throws(() => validateV2Plan(rewrittenBoundary, { sourcePath: planUrl.pathname }), /boundaries differ from behavior contract/);

  const missingAcceptance = structuredClone(sourcePlan);
  missingAcceptance.epics[0].tasks[0].acceptanceCriteria[0].statement = "Different statement";
  assert.throws(() => validateV2Plan(missingAcceptance, { sourcePath: planUrl.pathname }), /no traceable task acceptance/);

  const unpinnedWorkflow = structuredClone(sourcePlan);
  unpinnedWorkflow.workflow.revision = "main";
  assert.throws(() => validateV2Plan(unpinnedWorkflow, { sourcePath: planUrl.pathname }), /pattern/);

  const gitMetadata = structuredClone(sourcePlan);
  gitMetadata.epics[0].tasks[0].allowedPaths.push(".git/**");
  assert.throws(() => validateV2Plan(gitMetadata, { sourcePath: planUrl.pathname }), /Git metadata/);
});

test("behavior contract requires all decision sections once per requirement", () => {
  assert.equal(parseBehaviorContract(contract).length, 2);
  assert.throws(() => parseBehaviorContract(contract.replace("### Exceptions", "### Notes")), /exceptions/);
  assert.throws(() => parseBehaviorContract(`${contract}\n## REQ-001: duplicate\n`), /repeats/);
  assert.throws(() => parseBehaviorContract(contract.replace("### Exceptions", "### Behavior")), /repeats section/);
});
