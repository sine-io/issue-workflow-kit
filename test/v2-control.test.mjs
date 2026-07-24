import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskReview } from "../scripts/v2-review.mjs";
import {
  claimNextTask,
  blockReviewV2,
  parseV2Event,
  parseV2IssueIdentity,
  recordReviewV2,
  reconcileV2,
  submitTaskV2,
  syncV2Issues,
} from "../scripts/v2-control.mjs";
import { createTaskEnvelopeV2, v2RuntimeDigest, validateTaskCompletionV2 } from "../scripts/v2-runner-protocol.mjs";
import { v2PlanDigest, validateV2Plan } from "../scripts/v2-plan.mjs";

const sourcePlan = JSON.parse(fs.readFileSync(new URL("../examples/issue-plan.v2.example.json", import.meta.url), "utf8"));
const contract = fs.readFileSync(new URL("../examples/behavior-contract.v2.example.md", import.meta.url), "utf8");

function fixture({ tag = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iwf-control-"));
  const directory = path.join(root, ".github/issue-plans/IWF-20260724-DEMO");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "behavior-contract.md"), contract);
  const plan = structuredClone(sourcePlan);
  plan.$schema = "https://sine.io/issue-workflow-kit/iwf-plan.v2.schema.json";
  plan.repository = { owner: "acme", name: "example", defaultBranch: "main" };
  plan.plan.baseRevision = "a".repeat(40);
  plan.contract.path = "behavior-contract.md";
  if (tag) plan.epics[0].tasks[0].execution.allowedSideEffects = [`github:tag:${tag}`];
  plan.approval = { status: "approved", digest: v2PlanDigest(plan), approvedAt: "2026-07-24T00:00:00Z", approvedBy: "reviewer" };
  const planPath = path.join(directory, "plan.json");
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { root, plan, planPath };
}

class FakeGithub {
  constructor(plan) {
    this.plan = plan;
    this.labels = [];
    this.issues = [];
    this.comments = new Map();
    this.subIssues = new Map();
    this.blockedBy = new Map();
    this.pullRequests = [];
    this.files = new Map();
    this.checks = new Map();
    this.branchHeads = new Map([["main", "b".repeat(40)]]);
    this.tags = new Map();
    this.nextIssue = 100;
    this.nextComment = 1;
    this.nextPr = 20;
    this.planningPr = {
      number: 10,
      state: "closed",
      merged: true,
      merged_at: "2026-07-24T00:05:00Z",
      body: `<!-- iwf-plan-pr:v2 ${JSON.stringify({ digest: v2PlanDigest(plan), planId: plan.plan.id })} -->`,
      base: { ref: "main" },
    };
  }

  getAuthenticatedUser() { return { login: "iwf-bot" }; }
  getRepository() { return { full_name: "acme/example", default_branch: "main", allow_auto_merge: true }; }
  getBranch(repository, branch) { return { name: branch, commit: { sha: this.branchHeads.get(branch) || this.branchHeads.get("main") } }; }
  getCommit(repository, sha) { return { sha }; }
  listLabels() { return this.labels; }
  createLabel(repository, label) { this.labels.push({ ...label }); return label; }
  updateLabel() {}
  listIssues() { return this.issues; }
  createIssue(repository, input) {
    const issue = { number: this.nextIssue++, node_id: `I${this.nextIssue}`, html_url: `https://example.test/issues/${this.nextIssue}`, state: "open", user: { login: "iwf-bot" }, ...input };
    this.issues.push(issue);
    this.comments.set(issue.number, []);
    return issue;
  }
  updateIssue(repository, number, input) {
    const issue = this.issues.find((candidate) => candidate.number === number);
    Object.assign(issue, input);
    return issue;
  }
  getIssue(repository, number) { return this.issues.find((issue) => issue.number === number); }
  listIssueComments(repository, number) { return this.comments.get(number) || []; }
  createIssueComment(repository, number, body) {
    const comment = { id: this.nextComment++, created_at: new Date().toISOString(), user: { login: "iwf-bot" }, body };
    this.comments.get(number).push(comment);
    return comment;
  }
  listSubIssues(nodeId) { return [...(this.subIssues.get(nodeId) || [])]; }
  addSubIssue(parent, child) { if (!this.subIssues.has(parent)) this.subIssues.set(parent, []); this.subIssues.get(parent).push({ id: child }); }
  listBlockedBy(nodeId) { return [...(this.blockedBy.get(nodeId) || [])]; }
  addBlockedBy(issue, blocking) { if (!this.blockedBy.has(issue)) this.blockedBy.set(issue, []); this.blockedBy.get(issue).push({ id: blocking }); }
  listPullRequests(repository, { state = "open", head } = {}) {
    const all = [this.planningPr, ...this.pullRequests];
    return all.filter((pull) => (state === "all" || pull.state === state) && (!head || `${repository.split("/")[0]}:${pull.head?.ref}` === head));
  }
  listPullRequestFiles(repository, number) { return this.files.get(number) || [
    { filename: ".github/issue-plans/IWF-20260724-DEMO/plan.json" },
    { filename: ".github/issue-plans/IWF-20260724-DEMO/behavior-contract.md" },
  ]; }
  createPullRequest(repository, input) {
    const pull = { number: this.nextPr++, state: "open", merged: false, user: { login: "iwf-bot" }, body: input.body, head: { ref: input.head, sha: this.branchHeads.get(input.head) }, base: { ref: input.base }, node_id: `P${this.nextPr}` };
    this.pullRequests.push(pull);
    this.files.set(pull.number, [{ filename: "scripts/changed.mjs", status: "added" }]);
    return pull;
  }
  getPullRequest(repository, number) { return this.pullRequests.find((pull) => pull.number === number) || this.planningPr; }
  listCommitChecks(repository, sha) { return this.checks.get(sha) || []; }
  mergePullRequest(repository, number) {
    const pull = this.getPullRequest(repository, number);
    pull.merged = true;
    pull.merged_at = "2026-07-24T00:10:00Z";
    pull.merge_commit_sha = "c".repeat(40);
    pull.state = "closed";
    const issueNumber = Number(String(pull.body).match(/Closes #([0-9]+)/)?.[1]);
    if (issueNumber) {
      this.getIssue(repository, issueNumber).state = "closed";
      this.getIssue(repository, issueNumber).closed_at = pull.merged_at;
    }
    return { merged: true, sha: "c".repeat(40) };
  }
  listPullRequestClosingIssues() {
    const issue = this.issues.find((candidate) => candidate.number === 101);
    return issue ? [{ number: issue.number, repository: { nameWithOwner: "acme/example" } }] : [];
  }
  getGitReference(repository, ref) {
    if (!this.tags.has(ref)) throw Object.assign(new Error("HTTP 404 missing tag"), { httpStatus: 404 });
    return { object: { sha: this.tags.get(ref) } };
  }
  createGitReference(repository, ref, sha) {
    this.tags.set(ref.slice("refs/".length), sha);
    return { ref, object: { sha } };
  }
}

function completion(envelope) {
  return {
    schemaVersion: "task-completion/v2",
    planId: envelope.planId,
    planDigest: envelope.planDigest,
    taskId: envelope.taskId,
    attemptId: envelope.attemptId,
    envelopeDigest: v2RuntimeDigest(envelope),
    status: "completed",
    baseRevision: envelope.baseRevision,
    commitSha: "c".repeat(40),
    changedFiles: [{ path: "scripts/changed.mjs", status: "added" }],
    acceptance: envelope.acceptance.map((item) => ({ id: item.id, requirementId: item.requirementId, status: "success", evidence: ["test evidence"] })),
    verification: envelope.verification.map((item) => ({ id: item.id, requirementIds: item.requirementIds, status: "success", command: item.command, exitCode: 0, evidence: ["exit code 0"] })),
    runner: envelope.runner,
    startedAt: "2026-07-24T00:11:00Z",
    finishedAt: "2026-07-24T00:12:00Z",
    block: null,
  };
}

test("v2 Issue sync creates stable identities, serial statuses, and native relationships", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  const result = await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  assert.equal(result.issues.length, 3);
  const tasks = result.issues.filter((issue) => parseV2IssueIdentity(issue.body)?.kind === "task");
  assert.ok(tasks[0].labels.includes("status:ready"));
  assert.ok(tasks[1].labels.includes("status:backlog"));
  assert.equal(parseV2IssueIdentity(tasks[0].body).planDigest, result.digest);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  assert.equal(adapter.issues.length, 3);
  const task = adapter.getIssue("acme/example", 101);
  task.body = `human preface\n\n${task.body}\n\nHuman follow-up`;
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  assert.match(task.body, /^human preface/);
  assert.match(task.body, /Human follow-up$/);
});

test("v2 Issue sync authenticates the automation identity before writes", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  adapter.getAuthenticatedUser = () => { throw new Error("authentication failed"); };
  await assert.rejects(() => syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter }), /authentication failed/);
  assert.equal(adapter.labels.length, 0);
  assert.equal(adapter.issues.length, 0);
});

test("claim, completion, two reviews, merge, and reconcile remain serial and auditable", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  const claim = await claimNextTask({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) });
  assert.equal(claim.status, "claimed");
  const result = completion(claim.envelope);
  validateTaskCompletionV2(result, claim.envelope);
  adapter.branchHeads.set(claim.envelope.branch, result.commitSha);
  const submitted = await submitTaskV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: claim.envelope, completion: result });
  assert.equal(submitted.status, "in-review");
  const issue = adapter.getIssue("acme/example", submitted.prNumber ? 101 : 101);
  const spec = createTaskReview({ kind: "spec", envelope: claim.envelope, completion: result, output: { verdict: "approved", summary: "Spec passes", findings: [] }, reviewedAt: "2026-07-24T00:13:00Z" });
  const code = createTaskReview({ kind: "code", envelope: claim.envelope, completion: result, output: { verdict: "approved", summary: "Code passes", findings: [] }, reviewedAt: "2026-07-24T00:14:00Z" });
  await recordReviewV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: claim.envelope, completion: result, issueNumber: 101, review: spec });
  await recordReviewV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: claim.envelope, completion: result, issueNumber: 101, review: code });
  adapter.checks.set(result.commitSha, [{ name: "test", state: "success" }]);
  const first = await reconcileV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, sync: false });
  assert.equal(first.reports[0].status, "merge-requested");
  const second = await reconcileV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, sync: false });
  assert.equal(second.reports[0].status, "complete");
  const taskComments = adapter.listIssueComments("acme/example", 101);
  assert.ok(taskComments.some((comment) => parseV2Event(comment.body)?.type === "complete"));
  const next = adapter.getIssue("acme/example", 102);
  assert.ok(next.labels.includes("status:ready"));
  assert.equal(issue.state, "closed");
});

test("a manual closure without a validated PR blocks instead of unlocking the next task", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  adapter.getIssue("acme/example", 101).state = "closed";
  const result = await reconcileV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, sync: false });
  assert.equal(result.reports[0].status, "blocked");
  assert.ok(adapter.getIssue("acme/example", 102).labels.includes("status:backlog"));
});

test("a manual Issue closure before merge blocks the task PR", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  const claim = await claimNextTask({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) });
  const result = completion(claim.envelope);
  adapter.branchHeads.set(claim.envelope.branch, result.commitSha);
  await submitTaskV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: claim.envelope, completion: result });
  const spec = createTaskReview({ kind: "spec", envelope: claim.envelope, completion: result, output: { verdict: "approved", summary: "Spec passes", findings: [] }, reviewedAt: "2026-07-24T00:13:00Z" });
  const code = createTaskReview({ kind: "code", envelope: claim.envelope, completion: result, output: { verdict: "approved", summary: "Code passes", findings: [] }, reviewedAt: "2026-07-24T00:14:00Z" });
  await recordReviewV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, issueNumber: 101, envelope: claim.envelope, completion: result, review: spec });
  await recordReviewV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, issueNumber: 101, envelope: claim.envelope, completion: result, review: code });
  adapter.checks.set(result.commitSha, [{ name: "test", state: "success" }]);
  adapter.getIssue("acme/example", 101).state = "closed";
  const reconciled = await reconcileV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, sync: false });
  assert.equal(reconciled.reports[0].status, "blocked");
  assert.equal(adapter.getPullRequest("acme/example", 20).merged, false);
});

test("state-machine markers from another GitHub identity are ignored", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  adapter.comments.get(101).push({
    id: 999,
    created_at: "2026-07-24T00:06:00Z",
    user: { login: "another-user" },
    body: `forged\n\n<!-- iwf-v2-event ${JSON.stringify({
      type: "complete",
      planId: fixtureData.plan.plan.id,
      planDigest: v2PlanDigest(fixtureData.plan),
      taskId: fixtureData.plan.epics[0].tasks[0].id,
      at: "2026-07-24T00:06:00Z",
    })} -->`,
  });
  const claim = await claimNextTask({
    plan: fixtureData.plan,
    planPath: fixtureData.planPath,
    repository: "acme/example",
    adapter,
    agent: "codex",
    baseRevision: "b".repeat(40),
  });
  assert.equal(claim.status, "claimed");
  assert.equal(claim.taskId, fixtureData.plan.epics[0].tasks[0].id);
});

test("a failed independent review records a terminal block instead of leaving in-review", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  const claim = await claimNextTask({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) });
  const result = completion(claim.envelope);
  adapter.branchHeads.set(claim.envelope.branch, result.commitSha);
  await submitTaskV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: claim.envelope, completion: result });
  const blocked = await blockReviewV2({
    plan: fixtureData.plan,
    planPath: fixtureData.planPath,
    repository: "acme/example",
    adapter,
    envelope: claim.envelope,
    completion: result,
    reason: "review job failed",
  });
  assert.equal(blocked.status, "blocked");
  assert.ok(adapter.getIssue("acme/example", 101).labels.includes("status:blocked"));
  const reconciled = await reconcileV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, sync: false });
  assert.equal(reconciled.reports[0].status, "blocked");
  const next = await claimNextTask({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) });
  assert.equal(next.status, "stopped");
});

test("declared release tags are created only after the squash merge and are idempotent", async () => {
  const fixtureData = fixture({ tag: "v2.0.0-test" });
  const adapter = new FakeGithub(fixtureData.plan);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  const claim = await claimNextTask({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) });
  const result = completion(claim.envelope);
  adapter.branchHeads.set(claim.envelope.branch, result.commitSha);
  await submitTaskV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: claim.envelope, completion: result });
  const spec = createTaskReview({ kind: "spec", envelope: claim.envelope, completion: result, output: { verdict: "approved", summary: "Spec passes", findings: [] }, reviewedAt: "2026-07-24T00:13:00Z" });
  const code = createTaskReview({ kind: "code", envelope: claim.envelope, completion: result, output: { verdict: "approved", summary: "Code passes", findings: [] }, reviewedAt: "2026-07-24T00:14:00Z" });
  await recordReviewV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, issueNumber: 101, envelope: claim.envelope, completion: result, review: spec });
  await recordReviewV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, issueNumber: 101, envelope: claim.envelope, completion: result, review: code });
  adapter.checks.set(result.commitSha, [{ name: "test", state: "success" }]);
  assert.equal((await reconcileV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, sync: false })).reports[0].status, "merge-requested");
  const completed = await reconcileV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, sync: false });
  assert.equal(completed.reports[0].status, "complete");
  assert.equal(adapter.tags.get("tags/v2.0.0-test"), "c".repeat(40));
  const again = await reconcileV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, sync: false });
  assert.equal(again.reports[0].status, "closed");
});

test("only a classified transient failure retries once; semantic failures stay blocked", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  const first = await claimNextTask({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) });
  const blocked = completion(first.envelope);
  blocked.status = "blocked";
  blocked.commitSha = null;
  blocked.changedFiles = [];
  blocked.acceptance = blocked.acceptance.map((item) => ({ ...item, status: "failed", evidence: ["runner unavailable"] }));
  blocked.verification = blocked.verification.map((item) => ({ ...item, status: "missing", exitCode: null, evidence: ["not run"] }));
  blocked.block = { kind: "transient", reason: "classified service failure", retryable: true };
  await submitTaskV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: first.envelope, completion: blocked });
  const retry = await claimNextTask({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) });
  assert.equal(retry.status, "claimed");
  assert.equal(retry.envelope.attempt, 2);

  const semantic = structuredClone(blocked);
  semantic.attemptId = retry.envelope.attemptId;
  semantic.envelopeDigest = v2RuntimeDigest(retry.envelope);
  semantic.block = { kind: "verification", reason: "tests failed", retryable: false };
  await submitTaskV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: retry.envelope, completion: semantic });
  const stopped = await claimNextTask({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) });
  assert.equal(stopped.status, "stopped");
  assert.match(stopped.reason, /blocked/);
});

test("a task PR that closes a second managed Issue is rejected before review", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  const claim = await claimNextTask({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) });
  const result = completion(claim.envelope);
  adapter.branchHeads.set(claim.envelope.branch, result.commitSha);
  adapter.listPullRequestClosingIssues = () => [
    { number: 101, repository: { nameWithOwner: "acme/example" } },
    { number: 102, repository: { nameWithOwner: "acme/example" } },
  ];
  await assert.rejects(() => submitTaskV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: claim.envelope, completion: result }), /multiple managed Issues/);
  assert.equal(adapter.listIssueComments("acme/example", 101).some((comment) => parseV2Event(comment.body)?.type === "submit"), false);
});

test("event markers preserve evidence containing an HTML comment terminator", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  const claim = await claimNextTask({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) });
  const result = completion(claim.envelope);
  result.acceptance[0].evidence = ["verified literal --> output"];
  adapter.branchHeads.set(claim.envelope.branch, result.commitSha);
  await submitTaskV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: claim.envelope, completion: result });
  const submit = adapter.listIssueComments("acme/example", 101).map((comment) => parseV2Event(comment.body)).find((event) => event?.type === "submit");
  assert.equal(submit.completion.acceptance[0].evidence[0], "verified literal --> output");
});

test("concurrent claims elect one comment winner and supersede the loser", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  const options = { plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) };
  const results = await Promise.all([claimNextTask(options), claimNextTask(options)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["claimed", "superseded"]);
  assert.equal(adapter.listIssueComments("acme/example", 101).filter((comment) => parseV2Event(comment.body)?.type === "superseded").length, 1);
});

test("reconcile turns an expired claim into a non-retryable stale block", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  await claimNextTask({
    plan: fixtureData.plan,
    planPath: fixtureData.planPath,
    repository: "acme/example",
    adapter,
    agent: "codex",
    baseRevision: "b".repeat(40),
    attemptClock: () => new Date("2026-07-24T00:00:00Z"),
  });
  const result = await reconcileV2({
    plan: fixtureData.plan,
    planPath: fixtureData.planPath,
    repository: "acme/example",
    adapter,
    sync: false,
    clock: () => new Date("2026-07-24T02:00:00Z"),
  });
  assert.equal(result.reports[0].reason, "stale");
  const block = adapter.listIssueComments("acme/example", 101).map((comment) => parseV2Event(comment.body)).find((event) => event?.kind === "stale");
  assert.equal(block.retryable, false);
});

test("review disagreement blocks the task and never calls merge", async () => {
  const fixtureData = fixture();
  const adapter = new FakeGithub(fixtureData.plan);
  let merges = 0;
  const originalMerge = adapter.mergePullRequest.bind(adapter);
  adapter.mergePullRequest = (...args) => { merges += 1; return originalMerge(...args); };
  await syncV2Issues({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter });
  const claim = await claimNextTask({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, agent: "codex", baseRevision: "b".repeat(40) });
  const result = completion(claim.envelope);
  adapter.branchHeads.set(claim.envelope.branch, result.commitSha);
  await submitTaskV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: claim.envelope, completion: result });
  const spec = createTaskReview({ kind: "spec", envelope: claim.envelope, completion: result, output: { verdict: "approved", summary: "Spec passes", findings: [] }, reviewedAt: "2026-07-24T00:13:00Z" });
  const code = createTaskReview({
    kind: "code", envelope: claim.envelope, completion: result,
    output: { verdict: "changes-requested", summary: "Regression risk", findings: [{ severity: "high", requirementIds: ["REQ-001"], path: "scripts/changed.mjs", line: 1, message: "unsafe behavior" }] },
    reviewedAt: "2026-07-24T00:14:00Z",
  });
  await recordReviewV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: claim.envelope, completion: result, issueNumber: 101, review: spec });
  await recordReviewV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, envelope: claim.envelope, completion: result, issueNumber: 101, review: code });
  adapter.checks.set(result.commitSha, [{ name: "test", state: "success" }]);
  const reconciled = await reconcileV2({ plan: fixtureData.plan, planPath: fixtureData.planPath, repository: "acme/example", adapter, sync: false });
  assert.equal(reconciled.reports[0].status, "blocked");
  assert.equal(merges, 0);
  assert.equal(adapter.getIssue("acme/example", 101).state, "open");
});
