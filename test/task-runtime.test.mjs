import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { identityMarker } from "../scripts/plan-domain.mjs";
import { approvalDigest } from "../scripts/plan-validation.mjs";
import { createCompletionResult, parseMarker } from "../scripts/runtime-domain.mjs";
import { blockTask, claimTask, heartbeatTask, reconcileTasks, resumeTask, submitTask } from "../scripts/task-runtime.mjs";

const sourcePlan = JSON.parse(fs.readFileSync(new URL("../examples/issue-plan.v1.1.example.json", import.meta.url), "utf8"));
const repository = sourcePlan.workflow.repository;

function approvedPlan({ maxAttempts = 2 } = {}) {
  const plan = structuredClone(sourcePlan);
  plan.epics[0].tasks[0].execution.maxAttempts = maxAttempts;
  plan.approval = {
    status: "approved",
    digest: approvalDigest(plan),
    approvedAt: "2026-07-23T00:00:00Z",
    approvedBy: "reviewer",
  };
  return plan;
}

class RuntimeAdapter {
  constructor(plan, { injectEarlierClaim = false } = {}) {
    const tasks = plan.epics.flatMap((epic) => epic.tasks);
    this.issues = tasks.map((task, index) => ({
      number: 42 + index,
      node_id: `node-${42 + index}`,
      html_url: `https://example.test/issues/${42 + index}`,
      state: "open",
      body: identityMarker(plan, task),
      labels: [
        { name: "type:task" },
        { name: `priority:${task.priority}` },
        { name: task.dependsOn.length ? "status:backlog" : "status:ready" },
      ],
    }));
    this.issue = this.issues[0];
    this.commentsByIssue = new Map(this.issues.map((issue) => [issue.number, []]));
    this.comments = this.commentsByIssue.get(this.issue.number);
    this.nextComment = 1;
    this.writes = [];
    this.injectEarlierClaim = injectEarlierClaim;
    this.files = [{ filename: tasks[0].allowedPaths[0], status: "modified" }];
    this.pullRequest = null;
    this.checks = [];
    this.timeline = [];
    this.closingIssues = [{ number: this.issue.number, repository: { nameWithOwner: repository } }];
  }

  async listIssues() { return structuredClone(this.issues); }
  async getIssue(_repository, number) { return structuredClone(this.issues.find((issue) => issue.number === number)); }
  async listIssueComments(_repository, number) { return structuredClone(this.commentsByIssue.get(number) || []); }

  async createIssueComment(_repository, number, body) {
    const comments = this.commentsByIssue.get(number);
    if (this.injectEarlierClaim) {
      this.injectEarlierClaim = false;
      comments.push({ id: this.nextComment++, body, created_at: "2026-07-23T00:00:00.000Z" });
    }
    const comment = { id: this.nextComment++, body, created_at: "2026-07-23T00:00:00.001Z" };
    comments.push(comment);
    this.writes.push({ action: "createComment", id: comment.id });
    return structuredClone(comment);
  }

  async updateIssueComment(_repository, id, body) {
    const comment = [...this.commentsByIssue.values()].flat().find((candidate) => candidate.id === id);
    comment.body = body;
    this.writes.push({ action: "updateComment", id });
    return structuredClone(comment);
  }

  async updateIssue(_repository, number, input) {
    const issue = this.issues.find((candidate) => candidate.number === number);
    if (input.labels) issue.labels = input.labels.map((name) => ({ name }));
    this.writes.push({ action: "updateIssue", fields: Object.keys(input) });
    return structuredClone(issue);
  }

  async getRepository() { return { nameWithOwner: repository, default_branch: "main" }; }

  async getPullRequest(_repository, number) {
    if (this.pullRequest) return structuredClone(this.pullRequest);
    const attempt = this.comments.map((comment) => parseMarker(comment.body, "attempt")).find(Boolean);
    return {
      number,
      node_id: "pr-node",
      state: "open",
      body: `Implementation evidence\n\nCloses #${this.issue.number}`,
      base: { ref: "main", repo: { full_name: repository } },
      head: { ref: attempt.envelope.branch, sha: "head-sha", repo: { full_name: repository } },
    };
  }

  async listPullRequestFiles() { return structuredClone(this.files); }
  async listCommitChecks() { return structuredClone(this.checks); }
  async listIssueTimeline() { return structuredClone(this.timeline); }
  async listPullRequestClosingIssues() { return structuredClone(this.closingIssues); }
}

const at = (value) => () => new Date(value);

test("claim, heartbeat, block, and resume maintain one attempt status comment", async () => {
  const plan = approvedPlan();
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan);
  const claimed = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter, clock: at("2026-07-23T00:00:00Z") });
  assert.equal(claimed.attemptId, `${taskId}-A01`);
  assert.ok(adapter.issue.labels.some((label) => label.name === "status:in-progress"));
  assert.equal(adapter.comments.length, 1);

  const repeated = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });
  assert.equal(repeated.changed, false);

  await heartbeatTask({ plan, repository, attemptId: claimed.attemptId, note: "tests running", adapter, clock: at("2026-07-23T00:05:00Z") });
  assert.equal(adapter.comments.length, 1);
  assert.equal(parseMarker(adapter.comments[0].body, "attempt").note, "tests running");

  const blocked = await blockTask({
    plan,
    repository,
    attemptId: claimed.attemptId,
    kind: "verification",
    reason: "required test failed",
    adapter,
    clock: at("2026-07-23T00:06:00Z"),
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(adapter.issue.labels.some((label) => label.name === "status:blocked"));
  const writesAfterBlock = adapter.writes.length;
  const repeatedBlock = await blockTask({
    plan,
    repository,
    attemptId: claimed.attemptId,
    kind: "verification",
    reason: "required test failed",
    adapter,
  });
  assert.equal(repeatedBlock.changed, false);
  assert.equal(adapter.writes.length, writesAfterBlock);

  const resumed = await resumeTask({
    plan,
    repository,
    taskId,
    fromAttempt: claimed.attemptId,
    agent: "example-agent",
    adapter,
    clock: at("2026-07-23T00:10:00Z"),
  });
  assert.equal(resumed.attemptId, `${taskId}-A02`);
  assert.ok(adapter.issue.labels.some((label) => label.name === "status:in-progress"));
  const attempts = adapter.comments.map((comment) => parseMarker(comment.body, "attempt")).filter(Boolean);
  assert.equal(attempts.find((attempt) => attempt.attempt === 1).status, "superseded");
  assert.equal(attempts.find((attempt) => attempt.attempt === 2).status, "in-progress");
});

test("resume refuses attempts beyond the approved maxAttempts with zero writes", async () => {
  const plan = approvedPlan({ maxAttempts: 1 });
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan);
  const claim = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });
  await blockTask({ plan, repository, attemptId: claim.attemptId, kind: "needs-input", reason: "decision needed", adapter });
  adapter.writes = [];
  await assert.rejects(
    () => resumeTask({ plan, repository, taskId, fromAttempt: claim.attemptId, agent: "example-agent", adapter }),
    /exceeds approved maxAttempts/,
  );
  assert.deepEqual(adapter.writes, []);
});

test("a concurrent claim loser records superseded without changing task status", async () => {
  const plan = approvedPlan();
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan, { injectEarlierClaim: true });
  const result = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });
  assert.equal(result.status, "superseded");
  assert.ok(adapter.issue.labels.some((label) => label.name === "status:ready"));
  assert.equal(adapter.writes.filter((write) => write.action === "updateIssue").length, 0);
  assert.ok(adapter.comments.some((comment) => parseMarker(comment.body, "event")?.type === "superseded"));
});

function completionFor(envelope, result = "success") {
  return createCompletionResult({
    envelope,
    result,
    acceptance: envelope.acceptance.map((run) => ({ id: run.id, status: result === "success" ? "success" : "failed", evidence: ["criterion checked"] })),
    verification: envelope.verification.map((run) => ({ id: run.id, status: result === "success" ? "success" : "failed", evidence: ["command result recorded"] })),
  });
}

test("submit validates evidence and authoritative PR files before entering review", async () => {
  const plan = approvedPlan();
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan);
  const claim = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });
  adapter.writes = [];
  const result = await submitTask({
    plan,
    repository,
    attemptId: claim.attemptId,
    pr: 17,
    result: completionFor(claim.envelope),
    adapter,
  });
  assert.equal(result.status, "in-review");
  assert.ok(adapter.issue.labels.some((label) => label.name === "status:in-review"));
  assert.ok(adapter.comments.some((comment) => parseMarker(comment.body, "event")?.type === "submit"));
  const writes = adapter.writes.length;
  const repeated = await submitTask({
    plan,
    repository,
    attemptId: claim.attemptId,
    pr: 17,
    result: completionFor(claim.envelope),
    adapter,
  });
  assert.equal(repeated.changed, false);
  assert.equal(adapter.writes.length, writes);
});

test("submit failures and rename boundary violations perform zero writes", async () => {
  const plan = approvedPlan();
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan);
  const claim = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });

  const missing = completionFor(claim.envelope);
  missing.verification = [];
  adapter.writes = [];
  await assert.rejects(
    () => submitTask({ plan, repository, attemptId: claim.attemptId, pr: 17, result: missing, adapter }),
    /verification|fewer than 1/,
  );
  assert.deepEqual(adapter.writes, []);

  adapter.files = [{
    filename: plan.epics[0].tasks[0].allowedPaths[0],
    previous_filename: "private/secret.txt",
    status: "renamed",
  }];
  await assert.rejects(
    () => submitTask({ plan, repository, attemptId: claim.attemptId, pr: 17, result: completionFor(claim.envelope), adapter }),
    /outside allowedPaths/,
  );
  assert.deepEqual(adapter.writes, []);
});

test("partial and failed completion results move the attempt to blocked", async () => {
  const plan = approvedPlan();
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan);
  const claim = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });
  const result = await submitTask({
    plan,
    repository,
    attemptId: claim.attemptId,
    pr: 18,
    result: completionFor(claim.envelope, "partial"),
    adapter,
  });
  assert.equal(result.status, "blocked");
  assert.ok(adapter.issue.labels.some((label) => label.name === "status:blocked"));
});

async function markMerged(adapter, prNumber, requiredChecks, { closure = true } = {}) {
  const pr = await adapter.getPullRequest(repository, prNumber);
  adapter.pullRequest = {
    ...pr,
    state: "closed",
    merged: true,
    merged_at: "2026-07-23T00:15:00Z",
    merge_commit_sha: "merge-sha",
  };
  adapter.issue.state = "closed";
  adapter.checks = requiredChecks.map((name) => ({ name, state: "success", source: "check-run", detailsUrl: null }));
  adapter.timeline = closure
    ? [{ event: "closed", source: { issue: { number: prNumber, pull_request: {} } } }]
    : [{ event: "closed" }];
}

test("reconcile turns stale attempts into blocked without retrying", async () => {
  const plan = approvedPlan();
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan);
  await claimTask({ plan, repository, taskId, agent: "example-agent", adapter, clock: at("2026-07-23T00:00:00Z") });
  adapter.writes = [];
  const first = await reconcileTasks({ plan, repository, adapter, clock: at("2026-07-23T00:05:01Z") });
  assert.ok(first.operations.some((operation) => operation.action === "block-stale"));
  assert.ok(adapter.issue.labels.some((label) => label.name === "status:blocked"));
  assert.equal(adapter.comments.filter((comment) => parseMarker(comment.body, "attempt")).length, 1);
  assert.ok(adapter.comments.some((comment) => parseMarker(comment.body, "event")?.type === "stale"));

  adapter.writes = [];
  const repeated = await reconcileTasks({ plan, repository, adapter, clock: at("2026-07-23T00:10:00Z") });
  assert.deepEqual(repeated.operations, []);
  assert.deepEqual(adapter.writes, []);
});

test("reconcile completes only merged, checked, closing-reference submissions", async () => {
  const plan = approvedPlan();
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan);
  const claim = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });
  await submitTask({ plan, repository, attemptId: claim.attemptId, pr: 21, result: completionFor(claim.envelope), adapter });
  await markMerged(adapter, 21, claim.envelope.requiredChecks);
  adapter.writes = [];

  const result = await reconcileTasks({ plan, repository, adapter });
  assert.ok(result.operations.some((operation) => operation.action === "complete-event"));
  assert.ok(adapter.comments.some((comment) => parseMarker(comment.body, "event")?.type === "complete"));
  assert.equal(parseMarker(adapter.comments[0].body, "attempt").status, "complete");

  adapter.writes = [];
  const repeated = await reconcileTasks({ plan, repository, adapter });
  assert.deepEqual(repeated.operations, []);
  assert.deepEqual(adapter.writes, []);
});

test("reconcile accepts a PR cross-reference before a source-less closed event", async () => {
  const plan = approvedPlan();
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan);
  const claim = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });
  await submitTask({ plan, repository, attemptId: claim.attemptId, pr: 25, result: completionFor(claim.envelope), adapter });
  await markMerged(adapter, 25, claim.envelope.requiredChecks);
  adapter.timeline = [
    { event: "cross-referenced", source: { type: "issue", issue: { number: 25, pull_request: {} } } },
    { event: "closed", source: null, commit_id: null },
  ];
  adapter.writes = [];

  const result = await reconcileTasks({ plan, repository, adapter });
  assert.ok(result.operations.some((operation) => operation.action === "complete-event"));
  assert.equal(result.reports[0].evidence.issueClosedByPullRequest, true);

  adapter.writes = [];
  const repeated = await reconcileTasks({ plan, repository, adapter });
  assert.deepEqual(repeated.operations, []);
  assert.deepEqual(adapter.writes, []);
});

test("reconcile preserves merge commit closure evidence", async () => {
  const plan = approvedPlan();
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan);
  const claim = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });
  await submitTask({ plan, repository, attemptId: claim.attemptId, pr: 26, result: completionFor(claim.envelope), adapter });
  await markMerged(adapter, 26, claim.envelope.requiredChecks);
  adapter.timeline = [{ event: "closed", commit_id: "merge-sha" }];
  adapter.writes = [];

  const result = await reconcileTasks({ plan, repository, adapter });
  assert.ok(result.operations.some((operation) => operation.action === "complete-event"));
  assert.equal(result.reports[0].evidence.issueClosedByPullRequest, true);
});

test("source-less closure fallback rejects incomplete or out-of-order evidence", async () => {
  const scenarios = [
    {
      name: "ordinary Issue reference",
      timeline: (prNumber) => [
        { event: "cross-referenced", source: { type: "issue", issue: { number: prNumber } } },
        { event: "closed", source: null, commit_id: null },
      ],
    },
    {
      name: "different pull request",
      timeline: (prNumber) => [
        { event: "cross-referenced", source: { type: "issue", issue: { number: prNumber + 1, pull_request: {} } } },
        { event: "closed", source: null, commit_id: null },
      ],
    },
    {
      name: "pull request reference after close",
      timeline: (prNumber) => [
        { event: "closed", source: null, commit_id: null },
        { event: "cross-referenced", source: { type: "issue", issue: { number: prNumber, pull_request: {} } } },
      ],
    },
    {
      name: "missing GraphQL closing reference",
      timeline: (prNumber) => [
        { event: "cross-referenced", source: { type: "issue", issue: { number: prNumber, pull_request: {} } } },
        { event: "closed", source: null, commit_id: null },
      ],
      closingIssues: [],
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const plan = approvedPlan();
    const taskId = plan.epics[0].tasks[0].id;
    const adapter = new RuntimeAdapter(plan);
    const prNumber = 30 + index;
    const claim = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });
    await submitTask({ plan, repository, attemptId: claim.attemptId, pr: prNumber, result: completionFor(claim.envelope), adapter });
    await markMerged(adapter, prNumber, claim.envelope.requiredChecks);
    adapter.timeline = scenario.timeline(prNumber);
    if (scenario.closingIssues) adapter.closingIssues = scenario.closingIssues;
    adapter.writes = [];

    const result = await reconcileTasks({ plan, repository, adapter });
    assert.equal(result.reports[0].status, "in-review", scenario.name);
    assert.equal(result.reports[0].evidence.issueClosedByPullRequest, false, scenario.name);
    assert.deepEqual(adapter.writes, [], scenario.name);
  }
});

test("missing checks and manual Issue closure remain in review", async () => {
  const plan = approvedPlan();
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan);
  const claim = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });
  await submitTask({ plan, repository, attemptId: claim.attemptId, pr: 22, result: completionFor(claim.envelope), adapter });
  await markMerged(adapter, 22, claim.envelope.requiredChecks, { closure: false });
  adapter.checks = [];
  adapter.timeline.push({ event: "cross-referenced", source: { issue: { number: 22, pull_request: {} } } });
  adapter.writes = [];

  const result = await reconcileTasks({ plan, repository, adapter });
  const report = result.reports.find((candidate) => candidate.taskId === taskId);
  assert.equal(report.status, "in-review");
  assert.equal(report.evidence.issueClosedByPullRequest, false);
  assert.deepEqual(report.evidence.checks.missing, claim.envelope.requiredChecks);
  assert.deepEqual(adapter.writes, []);
  assert.ok(!adapter.comments.some((comment) => parseMarker(comment.body, "event")?.type === "complete"));
});

test("reconcile unlocks a successor only after every dependency completes", async () => {
  const plan = approvedPlan();
  const first = plan.epics[0].tasks[0];
  const second = {
    ...structuredClone(first),
    id: "DEMO-20260723-T02",
    title: "Second task",
    dependsOn: [first.id],
  };
  plan.epics[0].tasks.push(second);
  plan.approval.digest = approvalDigest(plan);
  const adapter = new RuntimeAdapter(plan);
  const claim = await claimTask({ plan, repository, taskId: first.id, agent: "example-agent", adapter });
  await submitTask({ plan, repository, attemptId: claim.attemptId, pr: 23, result: completionFor(claim.envelope), adapter });
  await markMerged(adapter, 23, claim.envelope.requiredChecks);
  adapter.writes = [];

  const result = await reconcileTasks({ plan, repository, adapter });
  assert.ok(result.operations.some((operation) => operation.taskId === second.id && operation.action === "set-ready"));
  const secondIssue = adapter.issues[1];
  assert.ok(secondIssue.labels.some((label) => label.name === "status:ready"));
  assert.ok(!secondIssue.labels.some((label) => label.name === "status:backlog"));
});

test("claim and submit recover idempotently after partial write failures", async () => {
  const plan = approvedPlan();
  const taskId = plan.epics[0].tasks[0].id;
  const adapter = new RuntimeAdapter(plan);
  const originalGetIssue = adapter.getIssue.bind(adapter);
  let failStatusRead = true;
  adapter.getIssue = async (...args) => {
    if (failStatusRead) {
      failStatusRead = false;
      throw new Error("simulated status read failure");
    }
    return originalGetIssue(...args);
  };
  await assert.rejects(
    () => claimTask({ plan, repository, taskId, agent: "example-agent", adapter }),
    /simulated status read failure/,
  );
  assert.equal(adapter.comments.filter((comment) => parseMarker(comment.body, "attempt")).length, 1);
  assert.ok(adapter.issue.labels.some((label) => label.name === "status:ready"));
  const recoveredClaim = await claimTask({ plan, repository, taskId, agent: "example-agent", adapter });
  assert.equal(recoveredClaim.changed, true);
  assert.ok(recoveredClaim.envelope);
  assert.ok(adapter.issue.labels.some((label) => label.name === "status:in-progress"));

  const originalCreateComment = adapter.createIssueComment.bind(adapter);
  let failSubmitEvent = true;
  adapter.createIssueComment = async (...args) => {
    if (failSubmitEvent) {
      failSubmitEvent = false;
      throw new Error("simulated event failure");
    }
    return originalCreateComment(...args);
  };
  const completion = completionFor(recoveredClaim.envelope);
  await assert.rejects(
    () => submitTask({ plan, repository, attemptId: recoveredClaim.attemptId, pr: 24, result: completion, adapter }),
    /simulated event failure/,
  );
  assert.ok(adapter.issue.labels.some((label) => label.name === "status:in-progress"));
  const recoveredSubmit = await submitTask({
    plan,
    repository,
    attemptId: recoveredClaim.attemptId,
    pr: 24,
    result: completion,
    adapter,
  });
  assert.equal(recoveredSubmit.status, "in-review");
  assert.ok(adapter.issue.labels.some((label) => label.name === "status:in-review"));
  assert.equal(adapter.comments.filter((comment) => parseMarker(comment.body, "event")?.type === "submit").length, 1);
});
