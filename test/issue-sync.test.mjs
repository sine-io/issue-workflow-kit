import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { syncIssues } from "../scripts/issue-sync.mjs";

const plan = JSON.parse(fs.readFileSync(new URL("../.github/issue-plans/IWF-20260722.json", import.meta.url), "utf8"));
const repository = "sine-io/issue-project-workflow-template";

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
  assert.equal(adapter.labels.size, 9);
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
  assert.equal(result.operations.filter((operation) => operation.action === "create").length, 18);
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
