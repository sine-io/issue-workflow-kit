import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runCodexReview } from "../scripts/codex-reviewer.mjs";
import { runCodexTask } from "../scripts/codex-runner.mjs";
import { createTaskEnvelopeV2, v2RuntimeDigest } from "../scripts/v2-runner-protocol.mjs";
import { createTaskReview, validateTaskReview } from "../scripts/v2-review.mjs";
import { v2PlanDigest, validateV2Plan } from "../scripts/v2-plan.mjs";

const planUrl = new URL("../examples/issue-plan.v2.example.json", import.meta.url);
const sourcePlan = JSON.parse(fs.readFileSync(planUrl, "utf8"));

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function setup() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "iwf-review-"));
  const root = path.join(parent, "workspace");
  fs.mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.test"]);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts/base.mjs"), "export const base = true;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const baseRevision = git(root, ["rev-parse", "HEAD"]);
  const plan = structuredClone(sourcePlan);
  plan.plan.baseRevision = baseRevision;
  plan.approval = { status: "approved", digest: v2PlanDigest(plan), approvedAt: "2026-07-24T00:00:00Z", approvedBy: "reviewer" };
  const validation = validateV2Plan(plan, { sourcePath: planUrl.pathname, requireApproval: true });
  const envelope = createTaskEnvelopeV2({ plan, taskId: plan.epics[0].tasks[0].id, issue: { number: 4, url: "https://example.test/issues/4" }, baseRevision, validation });
  return { parent, root, envelope };
}

function taskRunner(envelope, root) {
  return (command, args, options) => {
    if (command === "git") return spawnSync(command, args, options);
    if (args[0] === "--version") return { status: 0, stdout: `codex-cli ${envelope.runner.cliVersion}`, stderr: "" };
    fs.writeFileSync(path.join(root, "scripts/changed.mjs"), "export const changed = true;\n");
    const output = args[args.indexOf("--output-last-message") + 1];
    fs.writeFileSync(output, JSON.stringify({
      status: "completed",
      summary: "Implemented task",
      acceptance: envelope.acceptance.map((criterion) => ({ id: criterion.id, requirementId: criterion.requirementId, status: "success", evidence: ["verified"] })),
      blockedReason: null,
    }));
    return { status: 0, stdout: envelope.verification.map((verification) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: verification.command, exit_code: 0 } })).join("\n"), stderr: "" };
  };
}

function reviewRunner(envelope, root, verdict = "approved") {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "git") return spawnSync(command, args, options);
    if (args[0] === "--version") return { status: 0, stdout: `codex-cli ${envelope.runner.cliVersion}`, stderr: "" };
    const output = args[args.indexOf("--output-last-message") + 1];
    fs.writeFileSync(output, JSON.stringify({ verdict, summary: "Review complete", findings: [] }));
    return { status: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

test("independent spec and code reviews are structured and pinned to one commit SHA", async () => {
  const fixture = setup();
  const completion = await runCodexTask({
    envelope: fixture.envelope,
    workspace: fixture.root,
    outputPath: path.join(fixture.parent, "completion.json"),
    apiKey: "sk-runner-secret",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    runner: taskRunner(fixture.envelope, fixture.root),
  });
  const fake = reviewRunner(fixture.envelope, fixture.root);
  const review = await runCodexReview({
    kind: "spec",
    envelope: fixture.envelope,
    completion,
    workspace: fixture.root,
    outputPath: path.join(fixture.parent, "spec-review.json"),
    apiKey: "sk-review-secret",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_API_KEY: "sk-review-secret" },
    runner: fake.runner,
  });
  assert.equal(review.verdict, "approved");
  assert.equal(review.commitSha, completion.commitSha);
  assert.equal(review.envelopeDigest, v2RuntimeDigest(fixture.envelope));
  assert.equal(review.reviewPromptRevision, "spec-review-prompt/v1");
  assert.doesNotThrow(() => validateTaskReview(review, { kind: "spec", envelope: fixture.envelope, completion }));
  assert.ok(fake.calls.some((call) => call.args.includes("read-only")));
  const reviewCall = fake.calls.find((call) => call.args[0] === "exec");
  assert.equal(fake.calls.filter((call) => call.command === "git").some((call) => Object.hasOwn(call.options.env, "CODEX_API_KEY")), false);
  assert.match(reviewCall.args.at(-1), new RegExp(completion.commitSha));
  assert.match(reviewCall.args.at(-1), /Completion evidence/);
  assert.match(reviewCall.args.at(-1), /changedFiles/);
  assert.equal(JSON.stringify(review).includes("sk-review-secret"), false);
});

test("review rejects a report for a different commit and serious findings cannot be approved", () => {
  const fixture = setup();
  const completion = {
    schemaVersion: "task-completion/v2",
    planId: fixture.envelope.planId,
    planDigest: fixture.envelope.planDigest,
    taskId: fixture.envelope.taskId,
    attemptId: fixture.envelope.attemptId,
    envelopeDigest: v2RuntimeDigest(fixture.envelope),
    status: "completed",
    baseRevision: fixture.envelope.baseRevision,
    commitSha: "a".repeat(40),
    changedFiles: [{ path: "scripts/changed.mjs", status: "added" }],
    acceptance: fixture.envelope.acceptance.map((item) => ({ id: item.id, requirementId: item.requirementId, status: "success", evidence: ["ok"] })),
    verification: fixture.envelope.verification.map((item) => ({ id: item.id, requirementIds: item.requirementIds, status: "success", command: item.command, exitCode: 0, evidence: ["ok"] })),
    runner: fixture.envelope.runner,
    startedAt: "2026-07-24T00:00:00Z",
    finishedAt: "2026-07-24T00:01:00Z",
    block: null,
  };
  const serious = {
    verdict: "approved",
    summary: "Looks good",
    findings: [{ severity: "high", requirementIds: ["REQ-001"], path: "scripts/changed.mjs", line: 1, message: "unsafe" }],
  };
  assert.throws(() => createTaskReview({ kind: "spec", envelope: fixture.envelope, completion, output: serious, reviewedAt: "2026-07-24T00:01:00Z" }), /high findings/);
  const review = createTaskReview({ kind: "code", envelope: fixture.envelope, completion, output: { ...serious, verdict: "changes-requested" }, reviewedAt: "2026-07-24T00:01:00Z" });
  assert.throws(() => validateTaskReview(review, { kind: "code", envelope: fixture.envelope, completion: { ...completion, commitSha: "b".repeat(40) } }), /commit SHA/);
});
