import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { GitHubAdapter, GitHubGraphQLError } from "../scripts/github-adapter.mjs";
import { flattenPlan } from "../scripts/plan-domain.mjs";
import { syncIssues, syncRelationships } from "../scripts/issue-sync.mjs";
import { approvalDigest } from "../scripts/plan-validation.mjs";

const plan = JSON.parse(fs.readFileSync(new URL("../.github/issue-plans/IWF-20260722.json", import.meta.url), "utf8"));
const v11Plan = JSON.parse(fs.readFileSync(new URL("../examples/issue-plan.v1.1.example.json", import.meta.url), "utf8"));
const repository = "sine-io/issue-workflow-kit";

function clone(value) {
  return structuredClone(value);
}

class FakeAdapter {
  constructor({ failAfterCreates = null } = {}) {
    this.labels = new Map();
    this.issues = new Map();
    this.nextNumber = 100;
    this.failAfterCreates = failAfterCreates;
    this.createAttempts = 0;
    this.writes = [];
  }

  async listLabels() {
    return clone([...this.labels.values()]);
  }

  async createLabel(_repository, label) {
    this.writes.push({ action: "createLabel", name: label.name });
    this.labels.set(label.name, clone(label));
    return clone(label);
  }

  async updateLabel(_repository, currentName, label) {
    this.writes.push({ action: "updateLabel", name: currentName });
    this.labels.delete(currentName);
    this.labels.set(label.name, clone(label));
    return clone(label);
  }

  async listIssues() {
    return clone([...this.issues.values()]);
  }

  async getAssignee(_repository, login) {
    this.writes.push({ action: "checkAssignee", login });
    return { login };
  }

  async createIssue(_repository, input) {
    this.createAttempts += 1;
    if (this.failAfterCreates !== null && this.createAttempts > this.failAfterCreates) {
      throw new Error("simulated create failure");
    }
    const number = this.nextNumber++;
    const issue = {
      ...clone(input),
      number,
      node_id: `node-${number}`,
      html_url: `https://example.test/issues/${number}`,
      state: "open",
      labels: input.labels.map((name) => ({ name })),
    };
    this.writes.push({ action: "createIssue", number });
    this.issues.set(number, issue);
    return clone(issue);
  }

  async updateIssue(_repository, number, input) {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`missing issue ${number}`);
    this.writes.push({ action: "updateIssue", number, fields: Object.keys(input) });
    Object.assign(issue, clone(input));
    if (input.labels) issue.labels = input.labels.map((name) => ({ name }));
    return clone(issue);
  }
}

function sync(adapter, options = {}) {
  return syncIssues({ plan, repository, adapter, ...options });
}

test("first apply creates one Issue per stable plan identity and fixed labels", async () => {
  const adapter = new FakeAdapter();
  const result = await sync(adapter);
  assert.equal(result.issues.length, 9);
  assert.equal(adapter.issues.size, 9);
  assert.equal(adapter.labels.size, 10);
  assert.equal(adapter.writes.filter((write) => write.action === "createIssue").length, 9);
  for (const issue of adapter.issues.values()) {
    assert.match(issue.body, /issue-workflow:\{"planId":"IWF-20260722"/);
    assert.match(issue.body, /issue-workflow-managed:start/);
  }
});

test("a complete rerun is a no-op", async () => {
  const adapter = new FakeAdapter();
  await sync(adapter);
  adapter.writes = [];
  const result = await sync(adapter);
  assert.equal(result.issues.filter((issue) => issue.created).length, 0);
  assert.equal(adapter.writes.length, 0);
});

test("title changes, human text, extra labels, and closed state are preserved", async () => {
  const adapter = new FakeAdapter();
  await sync(adapter);
  const first = [...adapter.issues.values()].find((issue) => issue.title.startsWith("[IWF-20260722-T01]"));
  first.title = "Human title";
  first.body += "\nHuman decision: keep this wording.\n";
  first.labels.push({ name: "customer-note" });
  first.labels = first.labels.filter((label) => label.name !== "status:ready");
  first.labels.push({ name: "status:in-progress" });
  first.state = "closed";
  adapter.writes = [];

  await sync(adapter);
  const reused = adapter.issues.get(first.number);
  assert.equal(reused.title, "Human title");
  assert.equal(reused.state, "closed");
  assert.match(reused.body, /Human decision: keep this wording/);
  assert.deepEqual(reused.labels.map((label) => label.name).sort(), [
    "customer-note", "priority:P0", "status:in-progress", "type:task",
  ].sort());
});

test("a partial create failure can be rerun without duplicate identities", async () => {
  const adapter = new FakeAdapter({ failAfterCreates: 3 });
  await assert.rejects(() => sync(adapter), /simulated create failure/);
  adapter.failAfterCreates = null;
  await sync(adapter);
  assert.equal(adapter.issues.size, 9);
  const ids = [...adapter.issues.values()].map((issue) => issue.body.match(/\"taskId\":\"([^\"]+)/)[1]);
  assert.equal(new Set(ids).size, 9);
});

test("preview reports creates and updates without any adapter write", async () => {
  const adapter = new FakeAdapter();
  const result = await sync(adapter, { preview: true });
  assert.equal(adapter.issues.size, 0);
  assert.equal(adapter.labels.size, 0);
  assert.equal(adapter.writes.length, 0);
  assert.equal(result.preview, true);
  assert.equal(result.operations.filter((operation) => operation.action === "create").length, 19);
});

test("duplicate stable identities fail instead of guessing", async () => {
  const adapter = new FakeAdapter();
  await sync(adapter);
  const first = [...adapter.issues.values()][0];
  const duplicate = clone(first);
  duplicate.number = adapter.nextNumber++;
  duplicate.node_id = `node-${duplicate.number}`;
  adapter.issues.set(duplicate.number, duplicate);
  await assert.rejects(() => sync(adapter), /multiple Issues use identity/);
});

test("v1.1 metadata renders, syncs managed labels, and preserves assignees", async () => {
  const approved = clone(v11Plan);
  approved.approval = {
    status: "approved",
    digest: approvalDigest(approved),
    approvedAt: "2026-07-23T00:00:00Z",
    approvedBy: "reviewer",
  };
  const adapter = new FakeAdapter();
  const result = await syncIssues({ plan: approved, repository, adapter });
  assert.equal(result.issues.length, 2);
  assert.ok(adapter.labels.has("tag:example"));
  assert.ok(adapter.labels.has("cycle:2026-w52"));
  const issue = [...adapter.issues.values()][0];
  assert.match(issue.body, /## Management/);
  assert.match(issue.body, /Owner: `octocat`/);
  assert.deepEqual(issue.assignees, ["octocat"]);
  assert.ok(adapter.writes.some((write) => write.action === "checkAssignee"));

  issue.assignees.push("human-owner");
  adapter.writes = [];
  await syncIssues({ plan: approved, repository, adapter });
  assert.deepEqual(issue.assignees.sort(), ["human-owner", "octocat"]);
  assert.equal(adapter.writes.filter((write) => write.action === "checkAssignee").length, 1);
});

test("GitHub adapter paginates REST lists and retries transient failures", async () => {
  let attempts = 0;
  const sleeps = [];
  const runner = (args) => {
    attempts += 1;
    if (attempts === 1) return { status: 1, stdout: "", stderr: "HTTP 503" };
    const endpoint = args[1] || "";
    const page = new URL(`https://api.test/${endpoint}`).searchParams.get("page");
    const count = page === "1" ? 100 : 1;
    const values = Array.from({ length: count }, (_, index) => ({ name: `label-${page}-${index}` }));
    return { status: 0, stdout: JSON.stringify(values), stderr: "" };
  };
  const adapter = new GitHubAdapter({ runner, sleep: (ms) => sleeps.push(ms) });
  const labels = await adapter.listLabels(repository);
  assert.equal(labels.length, 101);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(attempts, 3);
});

test("GitHub adapter paginates GraphQL connections and surfaces GraphQL errors", async () => {
  const inputs = [];
  const runner = (args, options) => {
    if (args[0] !== "api" || args[1] !== "graphql") return { status: 0, stdout: "{}", stderr: "" };
    const request = JSON.parse(options.input);
    inputs.push(request.variables);
    const hasNext = request.variables.after === null;
    return {
      status: 0,
      stdout: JSON.stringify({ data: { node: { subIssues: {
        nodes: [{ id: hasNext ? "a" : "b", number: hasNext ? 1 : 2, url: "" }],
        pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? "cursor" : null },
      } } } }),
      stderr: "",
    };
  };
  const adapter = new GitHubAdapter({ runner });
  const values = await adapter.listSubIssues("parent-node");
  assert.deepEqual(values.map((value) => value.id), ["a", "b"]);
  assert.deepEqual(inputs.map((input) => input.after), [null, "cursor"]);

  const errorAdapter = new GitHubAdapter({ runner: () => ({
    status: 0,
    stdout: JSON.stringify({ errors: [{ message: "permission denied" }] }),
    stderr: "",
  }) });
  await assert.rejects(() => errorAdapter.listBlockedBy("node"), GitHubGraphQLError);
});

const relationRecords = flattenPlan(plan);

class RelationAdapter {
  constructor() {
    this.issues = relationRecords.map((record, index) => ({
      number: index + 2,
      node_id: `node-${record.id}`,
      html_url: `https://example.test/issues/${index + 2}`,
      body: `<!-- issue-workflow:{"planId":"${plan.plan.id}","taskId":"${record.id}","workflowRevision":"${plan.workflow.revision}"} -->`,
    }));
    this.subIssues = new Map();
    this.blockedBy = new Map();
    this.writes = [];
    this.failReads = false;
  }

  async listIssues() {
    return clone(this.issues);
  }

  async listSubIssues(nodeId) {
    if (this.failReads) throw new Error("GraphQL subIssues error");
    return clone(this.subIssues.get(nodeId) || []);
  }

  async listBlockedBy(nodeId) {
    if (this.failReads) throw new Error("GraphQL blockedBy error");
    return clone(this.blockedBy.get(nodeId) || []);
  }

  async addSubIssue(parentId, childId) {
    this.writes.push({ action: "addSubIssue", parentId, childId });
    const values = this.subIssues.get(parentId) || [];
    if (!values.some((ref) => ref.id === childId)) values.push({ id: childId, number: 0, url: "" });
    this.subIssues.set(parentId, values);
  }

  async removeSubIssue(parentId, childId) {
    this.writes.push({ action: "removeSubIssue", parentId, childId });
    this.subIssues.set(parentId, (this.subIssues.get(parentId) || []).filter((ref) => ref.id !== childId));
  }

  async addBlockedBy(issueId, blockingId) {
    this.writes.push({ action: "addBlockedBy", issueId, blockingId });
    const values = this.blockedBy.get(issueId) || [];
    if (!values.some((ref) => ref.id === blockingId)) values.push({ id: blockingId, number: 0, url: "" });
    this.blockedBy.set(issueId, values);
  }

  async removeBlockedBy(issueId, blockingId) {
    this.writes.push({ action: "removeBlockedBy", issueId, blockingId });
    this.blockedBy.set(issueId, (this.blockedBy.get(issueId) || []).filter((ref) => ref.id !== blockingId));
  }
}

function relationNode(record) {
  return `node-${record.id}`;
}

test("first relationship sync creates all native children and dependencies", async () => {
  const adapter = new RelationAdapter();
  const result = await syncRelationships({ plan, repository, adapter });
  assert.equal(result.operations.filter((op) => op.action === "add-sub-issue").length, 8);
  assert.equal(result.operations.filter((op) => op.action === "add-dependency").length, 7);
  assert.equal(adapter.writes.length, 15);
});

test("repeated relationship sync has no writes and external relationships survive", async () => {
  const adapter = new RelationAdapter();
  await syncRelationships({ plan, repository, adapter });
  const epic = relationRecords.find((record) => record.kind === "epic");
  const externalChild = "external-child-node";
  adapter.subIssues.get(relationNode(epic)).push({ id: externalChild, number: 999, url: "https://example.test/issues/999" });
  adapter.writes = [];
  const result = await syncRelationships({ plan, repository, adapter });
  assert.equal(result.operations.length, 0);
  assert.equal(adapter.writes.length, 0);
  assert.ok(adapter.subIssues.get(relationNode(epic)).some((ref) => ref.id === externalChild));
});

test("same-plan relationships are migrated and stale dependencies removed", async () => {
  const adapter = new RelationAdapter();
  await syncRelationships({ plan, repository, adapter });
  const epic = relationRecords.find((record) => record.kind === "epic");
  const t01 = relationRecords.find((record) => record.id.endsWith("T01"));
  const t02 = relationRecords.find((record) => record.id.endsWith("T02"));
  const t03 = relationRecords.find((record) => record.id.endsWith("T03"));
  adapter.subIssues.set(relationNode(epic), adapter.subIssues.get(relationNode(epic)).filter((ref) => ref.id !== relationNode(t01)));
  adapter.subIssues.set(relationNode(t02), [{ id: relationNode(t01), number: 0, url: "" }]);
  adapter.blockedBy.set(relationNode(t03), [
    { id: relationNode(t01), number: 0, url: "" },
    { id: "external-blocker", number: 998, url: "https://example.test/issues/998" },
  ]);
  adapter.writes = [];

  const result = await syncRelationships({ plan, repository, adapter });
  assert.ok(result.operations.some((op) => op.action === "remove-sub-issue" && op.parentId.endsWith("T02")));
  assert.ok(result.operations.some((op) => op.action === "add-sub-issue" && op.parentId === epic.id && op.childId === t01.id));
  assert.ok(result.operations.some((op) => op.action === "remove-dependency" && op.issueId === t03.id && op.blockingId === t01.id));
  assert.ok(result.operations.some((op) => op.action === "add-dependency" && op.issueId === t03.id && op.blockingId === t02.id));
  assert.ok(adapter.blockedBy.get(relationNode(t03)).some((ref) => ref.id === "external-blocker"));
});

test("relationship preview reads but performs no mutations", async () => {
  const adapter = new RelationAdapter();
  const result = await syncRelationships({ plan, repository, adapter, preview: true });
  assert.equal(result.operations.length, 15);
  assert.equal(adapter.writes.length, 0);
  assert.equal(adapter.subIssues.size, 0);
  assert.equal(adapter.blockedBy.size, 0);
});

test("GraphQL relationship errors stop synchronization", async () => {
  const adapter = new RelationAdapter();
  adapter.failReads = true;
  await assert.rejects(() => syncRelationships({ plan, repository, adapter }), /GraphQL subIssues error/);
  assert.equal(adapter.writes.length, 0);
});
