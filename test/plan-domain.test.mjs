import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  deriveInitialStatus,
  flattenPlan,
  identityMarker,
  labelsForExisting,
  labelsForNew,
  parseIdentity,
  reverseDependencies,
} from "../scripts/plan-domain.mjs";

const plan = JSON.parse(fs.readFileSync(new URL("../.github/issue-plans/IWF-20260722.json", import.meta.url), "utf8"));

test("flattenPlan keeps Epic ownership and cross-task dependencies", () => {
  const records = flattenPlan(plan);
  assert.equal(records.length, 9);
  assert.equal(records[0].kind, "epic");
  assert.equal(records[1].parentId, "IWF-20260722-E01");
  assert.equal(records.find((record) => record.id === "IWF-20260722-T08").dependsOn[0], "IWF-20260722-T07");
});

test("initial statuses are ready only for dependency-free tasks", () => {
  const records = flattenPlan(plan);
  assert.equal(deriveInitialStatus(records[0]), "status:backlog");
  assert.equal(deriveInitialStatus(records[1]), "status:ready");
  assert.equal(deriveInitialStatus(records[2]), "status:backlog");
  assert.deepEqual(labelsForNew(records[1]), ["type:task", "priority:P0", "status:ready"]);
});

test("existing labels preserve status and unrelated labels", () => {
  const task = flattenPlan(plan).find((record) => record.id === "IWF-20260722-T01");
  assert.deepEqual(labelsForExisting(task, ["type:task", "priority:P1", "status:in-progress", "customer-note"]), [
    "customer-note", "type:task", "priority:P0", "status:in-progress",
  ]);
});

test("identity markers are parseable and stable", () => {
  const task = flattenPlan(plan)[1];
  const marker = identityMarker(plan, task);
  assert.deepEqual(parseIdentity(marker), {
    planId: "IWF-20260722",
    taskId: "IWF-20260722-T01",
    workflowRevision: plan.workflow.revision,
  });
  assert.equal(parseIdentity("no marker"), null);
});

test("reverse dependencies support Blocks rendering", () => {
  const reverse = reverseDependencies(flattenPlan(plan));
  assert.deepEqual(reverse.get("IWF-20260722-T01"), ["IWF-20260722-T02"]);
});
