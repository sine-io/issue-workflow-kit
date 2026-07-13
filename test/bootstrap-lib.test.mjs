import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildIssueBody,
  flattenIssues,
  labelsForIssue,
  replaceTokens,
  reverseDependencies,
  summarize,
  validateConfig,
} from "../scripts/bootstrap-lib.mjs";

const example = JSON.parse(fs.readFileSync(new URL("../config/project-bootstrap.example.json", import.meta.url), "utf8"));

test("example manifest is valid and expands native sub-issues", () => {
  const issues = validateConfig(example);
  assert.equal(issues.length, 3);
  assert.equal(issues.filter((item) => item.parentId).length, 1);
  assert.equal(issues.find((item) => item.id === "EPIC-001.1").parentId, "EPIC-001");
  assert.deepEqual(summarize(example, issues), {
    projectTitle: "{{repo}} Delivery",
    labels: 13,
    issues: 2,
    subIssues: 1,
    epics: 1,
    dependencies: 1,
  });
});

test("children inherit project fields from their parent", () => {
  const issues = flattenIssues([{
    id: "EPIC-001",
    priority: "P0",
    phase: "1 Foundation",
    area: "area:system",
    children: [{ id: "EPIC-001.1" }],
  }]);
  const child = issues[1];
  assert.equal(child.priority, "P0");
  assert.equal(child.phase, "1 Foundation");
  assert.equal(child.area, "area:system");
  assert.deepEqual(labelsForIssue(child), ["priority:P0", "area:system", "subtask"]);
});

test("dependency cycles and missing references are rejected", () => {
  const config = structuredClone(example);
  config.issues[0].dependsOn = ["TASK-001"];
  config.issues[1].dependsOn = ["EPIC-001"];
  assert.throws(() => validateConfig(config), /Dependency cycle/);

  const missing = structuredClone(example);
  missing.issues[1].dependsOn = ["MISSING-001"];
  assert.throws(() => validateConfig(missing), /unknown dependency/);
});

test("issue body contains concrete parent and dependency references", () => {
  const issues = validateConfig(example);
  const refs = new Map([
    ["EPIC-001", { number: 1 }],
    ["EPIC-001.1", { number: 2 }],
    ["TASK-001", { number: 3 }],
  ]);
  const reverse = reverseDependencies(issues);
  const child = issues.find((item) => item.id === "EPIC-001.1");
  const body = buildIssueBody(child, refs, reverse);
  assert.match(body, /Parent Epic: #1/);
  assert.match(body, /Blocks: #3/);
  assert.match(body, /Closes #2/);
  assert.doesNotMatch(body, /TBD|undefined/);
});

test("repository tokens are replaced deterministically", () => {
  assert.equal(
    replaceTokens("{{owner}}/{{repo}} {{repository}}", { owner: "acme", repo: "demo" }),
    "acme/demo acme/demo",
  );
});
