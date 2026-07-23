import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { syncIssues, syncRelationships } from "../scripts/issue-sync.mjs";
import { parseIdentity } from "../scripts/plan-domain.mjs";
import { approvalDigest } from "../scripts/plan-validation.mjs";
import { createCompletionResult, parseMarker } from "../scripts/runtime-domain.mjs";
import { claimTask, heartbeatTask, reconcileTasks, submitTask } from "../scripts/task-runtime.mjs";

const source = JSON.parse(fs.readFileSync(new URL("../examples/issue-plan.v1.1.example.json", import.meta.url), "utf8"));

function integrationPlan() {
  const plan = structuredClone(source);
  const first = plan.epics[0].tasks[0];
  const second = {
    ...structuredClone(first),
    id: "DEMO-20260723-T02",
    title: "Verify dependency unlock",
    dependsOn: [first.id],
  };
  plan.epics[0].tasks.push(second);
  plan.approval = {
    status: "approved",
    digest: approvalDigest(plan),
    approvedAt: "2026-07-23T00:00:00Z",
    approvedBy: "reviewer",
  };
  return plan;
}

function clone(value) {
  return structuredClone(value);
}

class EndToEndAdapter {
  constructor(plan) {
    this.plan = plan;
    this.labels = new Map();
    this.issues = new Map();
    this.comments = new Map();
    this.subIssues = new Map();
    this.blockedBy = new Map();
    this.nextIssue = 100;
    this.nextComment = 1;
    this.pullRequest = null;
    this.files = [];
    this.checks = [];
    this.timeline = new Map();
  }

  async getAssignee(_repository, login) { return { login }; }
  async listLabels() { return clone([...this.labels.values()]); }
  async createLabel(_repository, label) { this.labels.set(label.name, clone(label)); return clone(label); }
  async updateLabel(_repository, current, label) {
    this.labels.delete(current);
    this.labels.set(label.name, clone(label));
    return clone(label);
  }
  async listIssues() { return clone([...this.issues.values()]); }
  async createIssue(_repository, input) {
    const number = this.nextIssue++;
    const issue = {
      ...clone(input),
      number,
      node_id: `node-${number}`,
      html_url: `https://example.test/issues/${number}`,
      state: "open",
      labels: input.labels.map((name) => ({ name })),
      assignees: (input.assignees || []).map((login) => ({ login })),
    };
    this.issues.set(number, issue);
    this.comments.set(number, []);
    return clone(issue);
  }
  async updateIssue(_repository, number, input) {
    const issue = this.issues.get(number);
    if (input.body !== undefined) issue.body = input.body;
    if (input.labels) issue.labels = input.labels.map((name) => ({ name }));
    if (input.assignees) issue.assignees = input.assignees.map((login) => ({ login }));
    return clone(issue);
  }
  async getIssue(_repository, number) { return clone(this.issues.get(number)); }
  async listSubIssues(nodeId) { return clone(this.subIssues.get(nodeId) || []); }
  async listBlockedBy(nodeId) { return clone(this.blockedBy.get(nodeId) || []); }
  async addSubIssue(parentId, childId) {
    const values = this.subIssues.get(parentId) || [];
    values.push({ id: childId });
    this.subIssues.set(parentId, values);
  }
  async removeSubIssue(parentId, childId) {
    this.subIssues.set(parentId, (this.subIssues.get(parentId) || []).filter((value) => value.id !== childId));
  }
  async addBlockedBy(issueId, blockingId) {
    const values = this.blockedBy.get(issueId) || [];
    values.push({ id: blockingId });
    this.blockedBy.set(issueId, values);
  }
  async removeBlockedBy(issueId, blockingId) {
    this.blockedBy.set(issueId, (this.blockedBy.get(issueId) || []).filter((value) => value.id !== blockingId));
  }
  async listIssueComments(_repository, number) { return clone(this.comments.get(number) || []); }
  async createIssueComment(_repository, number, body) {
    const comment = { id: this.nextComment++, created_at: "2026-07-23T00:00:00Z", body };
    this.comments.get(number).push(comment);
    return clone(comment);
  }
  async updateIssueComment(_repository, id, body) {
    const comment = [...this.comments.values()].flat().find((candidate) => candidate.id === id);
    comment.body = body;
    return clone(comment);
  }
  async getRepository() {
    return { nameWithOwner: this.plan.workflow.repository, default_branch: "main", has_issues: true, permissions: { push: true } };
  }
  async getPullRequest() { return clone(this.pullRequest); }
  async listPullRequestFiles() { return clone(this.files); }
  async listCommitChecks() { return clone(this.checks); }
  async listIssueTimeline(_repository, number) { return clone(this.timeline.get(number) || []); }
}

function issueFor(adapter, planId, taskId) {
  return [...adapter.issues.values()].find((issue) => {
    const identity = parseIdentity(issue.body);
    return identity?.planId === planId && identity.taskId === taskId;
  });
}

function hasStatus(issue, status) {
  return issue.labels.some((label) => label.name === `status:${status}`);
}

test("offline apply through reconcile closes evidence and unlocks the next task", async () => {
  const plan = integrationPlan();
  const repository = plan.workflow.repository;
  const [first, second] = plan.epics[0].tasks;
  const adapter = new EndToEndAdapter(plan);

  const applied = await syncIssues({ plan, repository, adapter });
  const relationships = await syncRelationships({ plan, repository, adapter, refs: applied.refs });
  assert.equal(applied.issues.length, 3);
  assert.equal(relationships.operations.filter((operation) => operation.action === "add-sub-issue").length, 2);
  assert.equal(relationships.operations.filter((operation) => operation.action === "add-dependency").length, 1);
  assert.equal(hasStatus(issueFor(adapter, plan.plan.id, first.id), "ready"), true);
  assert.equal(hasStatus(issueFor(adapter, plan.plan.id, second.id), "backlog"), true);

  const claimed = await claimTask({
    plan,
    repository,
    taskId: first.id,
    agent: "example-agent",
    adapter,
    clock: () => new Date("2026-07-23T00:00:00Z"),
  });
  await heartbeatTask({
    plan,
    repository,
    attemptId: claimed.attemptId,
    note: "verification running",
    adapter,
    clock: () => new Date("2026-07-23T00:02:00Z"),
  });
  const firstIssue = issueFor(adapter, plan.plan.id, first.id);
  adapter.pullRequest = {
    number: 88,
    state: "open",
    body: `Closes #${firstIssue.number}`,
    base: { ref: "main", repo: { full_name: repository } },
    head: { ref: claimed.envelope.branch, sha: "head-sha", repo: { full_name: repository } },
  };
  adapter.files = [{ filename: first.allowedPaths[0], status: "modified" }];
  const completion = createCompletionResult({
    envelope: claimed.envelope,
    result: "success",
    acceptance: claimed.envelope.acceptance.map((run) => ({ id: run.id, status: "success", evidence: ["accepted"] })),
    verification: claimed.envelope.verification.map((run) => ({ id: run.id, status: "success", evidence: ["passed"] })),
  });
  await submitTask({ plan, repository, attemptId: claimed.attemptId, pr: 88, result: completion, adapter });

  adapter.pullRequest = {
    ...adapter.pullRequest,
    state: "closed",
    merged: true,
    merged_at: "2026-07-23T00:10:00Z",
    merge_commit_sha: "merge-sha",
  };
  firstIssue.state = "closed";
  adapter.checks = claimed.envelope.requiredChecks.map((name) => ({ name, state: "success" }));
  adapter.timeline.set(firstIssue.number, [{ event: "closed", source: { issue: { number: 88, pull_request: {} } } }]);

  const reconciled = await reconcileTasks({ plan, repository, adapter });
  const secondIssue = issueFor(adapter, plan.plan.id, second.id);
  assert.ok(reconciled.operations.some((operation) => operation.taskId === first.id && operation.action === "complete-event"));
  assert.ok(reconciled.operations.some((operation) => operation.taskId === second.id && operation.action === "set-ready"));
  assert.equal(hasStatus(secondIssue, "ready"), true);
  assert.ok(adapter.comments.get(firstIssue.number).some((comment) => parseMarker(comment.body, "event")?.type === "complete"));
});
