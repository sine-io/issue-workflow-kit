import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { identityMarker } from "../scripts/plan-domain.mjs";
import { approvalDigest } from "../scripts/plan-validation.mjs";
import { createCompletionResult, parseMarker } from "../scripts/runtime-domain.mjs";
import { executeTask, parseTaskArgs } from "../scripts/task-workflow.mjs";

const planFile = "examples/issue-plan.v1.1.example.json";
const source = JSON.parse(fs.readFileSync(planFile, "utf8"));

function approvedPlan() {
  const plan = structuredClone(source);
  plan.epics[0].tasks[0].execution.maxAttempts = 2;
  plan.approval = {
    status: "approved",
    digest: approvalDigest(plan),
    approvedAt: "2026-07-23T00:00:00Z",
    approvedBy: "reviewer",
  };
  return plan;
}

class CliRuntimeAdapter {
  constructor(plan) {
    const task = plan.epics[0].tasks[0];
    this.repository = plan.workflow.repository;
    this.issue = {
      number: 55,
      state: "open",
      html_url: "https://example.test/issues/55",
      body: identityMarker(plan, task),
      labels: [{ name: "type:task" }, { name: "priority:P1" }, { name: "status:ready" }],
    };
    this.comments = [];
    this.nextComment = 1;
    this.writes = [];
    this.reads = [];
    this.pr = null;
    this.checks = [];
    this.timeline = [];
  }

  checkCli() { this.reads.push("checkCli"); }
  checkAuth() { this.reads.push("checkAuth"); }
  async getRepository() {
    this.reads.push("getRepository");
    return {
      nameWithOwner: this.repository,
      has_issues: true,
      default_branch: "main",
      permissions: { push: true },
    };
  }
  async getCommit() { this.reads.push("getCommit"); return { sha: source.plan.baseRevision }; }
  async listIssues() { this.reads.push("listIssues"); return [structuredClone(this.issue)]; }
  async getIssue() { this.reads.push("getIssue"); return structuredClone(this.issue); }
  async listIssueComments() { this.reads.push("listComments"); return structuredClone(this.comments); }
  async createIssueComment(_repository, _number, body) {
    const comment = { id: this.nextComment++, created_at: "2026-07-23T00:00:00Z", body };
    this.comments.push(comment);
    this.writes.push("createComment");
    return structuredClone(comment);
  }
  async updateIssueComment(_repository, id, body) {
    this.comments.find((comment) => comment.id === id).body = body;
    this.writes.push("updateComment");
  }
  async updateIssue(_repository, _number, input) {
    if (input.labels) this.issue.labels = input.labels.map((name) => ({ name }));
    this.writes.push("updateIssue");
    return structuredClone(this.issue);
  }
  async getPullRequest(_repository, number) {
    this.reads.push("getPullRequest");
    if (this.pr) return structuredClone(this.pr);
    const attempt = this.comments
      .map((comment) => parseMarker(comment.body, "attempt"))
      .filter(Boolean)
      .sort((left, right) => right.attempt - left.attempt)[0];
    return {
      number,
      state: "open",
      body: `Closes #${this.issue.number}`,
      base: { ref: "main", repo: { full_name: this.repository } },
      head: { ref: attempt.envelope.branch, sha: "head-sha", repo: { full_name: this.repository } },
    };
  }
  async listPullRequestFiles() {
    this.reads.push("listPullRequestFiles");
    return [{ filename: source.epics[0].tasks[0].allowedPaths[0], status: "modified" }];
  }
  async listCommitChecks() { this.reads.push("listCommitChecks"); return structuredClone(this.checks); }
  async listIssueTimeline() { this.reads.push("listIssueTimeline"); return structuredClone(this.timeline); }
}

function args(plan, command, specific = []) {
  return [
    command,
    "--plan", planFile,
    "--repo", plan.workflow.repository,
    "--approval-digest", plan.approval.digest,
    ...specific,
  ];
}

function options(plan, adapter, output, extra = {}) {
  return { adapter, write: (value) => output.push(JSON.parse(value)), loadPlan: () => plan, ...extra };
}

test("task CLI rejects missing, duplicate, and command-specific arguments", () => {
  assert.throws(() => parseTaskArgs(["task:claim"]), /--plan is required/);
  assert.throws(() => parseTaskArgs([
    "task:claim", "--plan", "a", "--plan", "b", "--repo", "a/b", "--approval-digest", "x", "--task-id", "T", "--agent", "a",
  ]), /duplicate/);
  assert.throws(() => parseTaskArgs([
    "task:reconcile", "--plan", "a", "--repo", "a/b", "--approval-digest", "x", "--agent", "a",
  ]), /unknown argument/);
});

test("all lifecycle commands emit JSON and support an end-to-end rerun", async () => {
  const plan = approvedPlan();
  const task = plan.epics[0].tasks[0];
  const adapter = new CliRuntimeAdapter(plan);
  const output = [];

  const claim = await executeTask(args(plan, "task:claim", ["--task-id", task.id, "--agent", "example-agent"]), options(plan, adapter, output));
  assert.equal(claim.command, "task:claim");
  assert.equal(output.at(-1).attemptId, claim.attemptId);

  await executeTask(args(plan, "task:heartbeat", ["--attempt-id", claim.attemptId, "--note", "working"]), options(plan, adapter, output));
  await executeTask(args(plan, "task:block", [
    "--attempt-id", claim.attemptId, "--kind", "needs-input", "--reason", "review needed",
  ]), options(plan, adapter, output));
  const resumed = await executeTask(args(plan, "task:resume", [
    "--task-id", task.id, "--from-attempt", claim.attemptId, "--agent", "example-agent",
  ]), options(plan, adapter, output));

  const completion = createCompletionResult({
    envelope: resumed.envelope,
    result: "success",
    acceptance: resumed.envelope.acceptance.map((run) => ({ id: run.id, status: "success", evidence: ["accepted"] })),
    verification: resumed.envelope.verification.map((run) => ({ id: run.id, status: "success", evidence: ["passed"] })),
  });
  const submitted = await executeTask(args(plan, "task:submit", [
    "--attempt-id", resumed.attemptId, "--pr", "77", "--result", "-",
  ]), options(plan, adapter, output, { loadResult: () => completion }));
  assert.equal(submitted.status, "in-review");

  const openPr = await adapter.getPullRequest(plan.workflow.repository, 77);
  adapter.pr = { ...openPr, state: "closed", merged: true, merged_at: "2026-07-23T01:00:00Z", merge_commit_sha: "merge-sha" };
  adapter.issue.state = "closed";
  adapter.checks = resumed.envelope.requiredChecks.map((name) => ({ name, state: "success" }));
  adapter.timeline = [{ event: "closed", source: { issue: { number: 77, pull_request: {} } } }];
  const reconciled = await executeTask(args(plan, "task:reconcile"), options(plan, adapter, output));
  assert.ok(reconciled.operations.some((operation) => operation.action === "complete-event"));
  assert.equal(output.length, 6);
});

test("approval preflight and invalid completion fail before lifecycle writes", async () => {
  const plan = approvedPlan();
  const task = plan.epics[0].tasks[0];
  const adapter = new CliRuntimeAdapter(plan);
  await assert.rejects(
    () => executeTask([
      "task:claim", "--plan", planFile, "--repo", plan.workflow.repository,
      "--approval-digest", "0".repeat(64), "--task-id", task.id, "--agent", "example-agent",
    ], options(plan, adapter, [])),
    /digest mismatch/,
  );
  assert.deepEqual(adapter.reads, []);
  assert.deepEqual(adapter.writes, []);

  const claim = await executeTask(args(plan, "task:claim", ["--task-id", task.id, "--agent", "example-agent"]), options(plan, adapter, []));
  adapter.writes = [];
  await assert.rejects(
    () => executeTask(args(plan, "task:submit", [
      "--attempt-id", claim.attemptId, "--pr", "77", "--result", "-",
    ]), options(plan, adapter, [], { loadResult: () => ({ schemaVersion: "task-completion/v1" }) })),
    /completion schema validation/,
  );
  assert.deepEqual(adapter.writes, []);
});
