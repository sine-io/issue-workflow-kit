import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";

import { mergeNeedsAnotherReconcile, reconcileForMerge } from "../scripts/workflow-control.mjs";

const reusableText = fs.readFileSync(new URL("../.github/workflows/issue-workflow-v2.yml", import.meta.url), "utf8");
const callerText = fs.readFileSync(new URL("../.github/workflows/issue-workflow.yml", import.meta.url), "utf8");

test("reusable workflow is statically parseable and keeps orchestration credentials out of Runner/review jobs", () => {
  const workflow = parse(reusableText);
  assert.ok(workflow.jobs.prepare);
  assert.ok(workflow.jobs.runner);
  assert.ok(workflow.jobs.publish);
  assert.ok(workflow.jobs["spec-review"]);
  assert.ok(workflow.jobs["code-review"]);
  assert.ok(workflow.jobs.merge);
  for (const job of ["prepare", "runner", "publish", "spec-review", "code-review", "merge"]) {
    assert.match(JSON.stringify(workflow.jobs[job]), /npm ci --prefix \.\.\/kit/);
  }
  assert.equal(JSON.stringify(workflow.jobs.runner).includes("IWF_TOKEN"), false);
  assert.equal(JSON.stringify(workflow.jobs["spec-review"]).includes("IWF_TOKEN"), false);
  assert.equal(JSON.stringify(workflow.jobs["code-review"]).includes("IWF_TOKEN"), false);
  assert.match(JSON.stringify(workflow.jobs.runner), /CODEX_API_KEY/);
  assert.match(JSON.stringify(workflow.jobs["spec-review"]), /CODEX_API_KEY/);
  assert.match(JSON.stringify(workflow.jobs.runner), /persist-credentials.*false/);
  assert.match(fs.readFileSync(new URL("../scripts/codex-runner.mjs", import.meta.url), "utf8"), /workspace-write/);
  assert.match(fs.readFileSync(new URL("../scripts/codex-reviewer.mjs", import.meta.url), "utf8"), /read-only/);
  assert.match(reusableText, /IWF_KIT_REVISION: \$\{\{ inputs\.kit_revision \}\}/);
  assert.match(reusableText, /IWF_CODEX_VERSION/);
  assert.match(reusableText, /path: target/);
  assert.match(reusableText, /path: kit/);
  assert.match(reusableText, /actions: write/);
  assert.match(reusableText, /group: iwf-control-/);
  assert.match(reusableText, /block-review/);
  assert.match(reusableText, /if: always\(\)/);
  assert.match(reusableText, /git update-ref/);
  assert.match(reusableText, /git bundle verify/);
  assert.match(reusableText, /inputs\['config-path'\]/);
  assert.equal(reusableText.includes("inputs.config-path"), false);
});

test("caller workflow uses one fixed reusable-workflow tag and the two split secrets", () => {
  const workflow = parse(callerText);
  assert.equal(workflow.jobs["issue-workflow"].uses, "sine-io/issue-workflow-kit/.github/workflows/issue-workflow-v2.yml@v2.0.0-alpha.1");
  assert.equal(workflow.jobs["issue-workflow"].with.kit_repository, "sine-io/issue-workflow-kit");
  assert.equal(workflow.jobs["issue-workflow"].with.kit_revision, "v2.0.0-alpha.1");
  assert.equal(workflow.jobs["issue-workflow"].with.codex_version, "0.145.0");
  assert.ok(workflow.jobs["issue-workflow"].secrets.IWF_TOKEN);
  assert.ok(workflow.jobs["issue-workflow"].secrets.CODEX_API_KEY);
  assert.equal(workflow.jobs["issue-workflow"].secrets.IWF_TOKEN, "${{ secrets.IWF_TOKEN }}");
  assert.equal(workflow.jobs["issue-workflow"].secrets.CODEX_API_KEY, "${{ secrets.CODEX_API_KEY }}");
  assert.match(callerText, /branches:\n\s+- main/);
  assert.match(callerText, /group: iwf-caller-/);
});

test("merge immediately reconciles the current task after earlier tasks are closed", () => {
  assert.equal(mergeNeedsAnotherReconcile({
    reports: [
      { taskId: "T01", status: "closed" },
      { taskId: "T02", status: "merge-requested" },
    ],
  }), true);
  assert.equal(mergeNeedsAnotherReconcile({ reports: [{ taskId: "T02", status: "pending" }] }), false);
});

test("merge waits for pending CI and immediately follows a successful merge", async () => {
  const results = [
    { reports: [{ taskId: "T02", status: "pending" }], stopped: true },
    { reports: [{ taskId: "T02", status: "merge-requested" }], stopped: true },
    { reports: [{ taskId: "T02", status: "complete", changed: true }], stopped: false },
  ];
  const pauses = [];
  const result = await reconcileForMerge({
    plan: {},
    planPath: "plan.json",
    repository: "sine-io/example",
    adapter: {},
    reconcile: async () => results.shift(),
    pause: async (milliseconds) => pauses.push(milliseconds),
    pollIntervalMs: 25,
    maxPolls: 3,
  });
  assert.equal(result.reports[0].status, "complete");
  assert.deepEqual(pauses, [25]);
});
