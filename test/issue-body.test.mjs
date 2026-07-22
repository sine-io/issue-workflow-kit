import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { flattenPlan, reverseDependencies } from "../scripts/plan-domain.mjs";
import {
  MANAGED_END,
  MANAGED_START,
  mergeManagedBody,
  renderManagedBody,
} from "../scripts/issue-body.mjs";

const plan = JSON.parse(fs.readFileSync(new URL("../.github/issue-plans/IWF-20260722.json", import.meta.url), "utf8"));
const records = flattenPlan(plan);
const refs = new Map(records.map((record, index) => [record.id, { number: index + 2 }]));
const reverse = reverseDependencies(records);

test("rendered body includes stable identity, scope, native refs, acceptance, verification, and stop conditions", () => {
  const task = records.find((record) => record.id === "IWF-20260722-T02");
  const body = renderManagedBody(plan, task, refs, reverse);
  assert.match(body, /issue-workflow-managed:start/);
  assert.match(body, /\"taskId\":\"IWF-20260722-T02\"/);
  assert.match(body, /\.github\/issue-plan\.schema\.json/);
  assert.match(body, /Parent Epic: #2/);
  assert.match(body, /Blocked by: #3/);
  assert.match(body, /Verification/);
  assert.match(body, /Stop on a failed check/);
  assert.doesNotMatch(body, /undefined|null/);
});

test("Epic body lists native child references", () => {
  const epic = records.find((record) => record.kind === "epic");
  const body = renderManagedBody(plan, epic, refs, reverse);
  assert.match(body, /Native Sub-issues/);
  assert.match(body, /#3 \(`IWF-20260722-T01`\)/);
});

test("mergeManagedBody replaces only the managed block and preserves human text", () => {
  const task = records[1];
  const old = `${MANAGED_START}\nold generated content\n${MANAGED_END}\n\nHuman decision\n`;
  const next = renderManagedBody(plan, task, refs, reverse);
  const merged = mergeManagedBody(old, next);
  assert.match(merged, /Human decision/);
  assert.doesNotMatch(merged, /old generated content/);
  assert.equal((merged.match(new RegExp(MANAGED_START, "g")) || []).length, 1);
  assert.equal((merged.match(new RegExp(MANAGED_END, "g")) || []).length, 1);
});

test("managed body replacement is byte-stable when human text ends with newlines", () => {
  const next = renderManagedBody(plan, records[1], refs, reverse);
  const original = `${MANAGED_START}\nold\n${MANAGED_END}\n\nHuman notes\n\n\n`;
  const first = mergeManagedBody(original, next);
  const second = mergeManagedBody(first, next);
  assert.equal(second, first);
});

test("a body without a managed block is retained after generated content", () => {
  const next = renderManagedBody(plan, records[1], refs, reverse);
  const merged = mergeManagedBody("Human-only note", next);
  assert.ok(merged.indexOf(MANAGED_START) < merged.indexOf("Human-only note"));
});

test("incomplete managed markers fail rather than overwriting text", () => {
  const next = renderManagedBody(plan, records[1], refs, reverse);
  assert.throws(() => mergeManagedBody(`${MANAGED_START}\npartial`, next), /incomplete/);
});
