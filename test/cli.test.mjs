import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { execute } from "../scripts/issue-workflow.mjs";

const planFile = ".github/issue-plans/IWF-20260722.json";
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const repository = plan.workflow.repository;

class CliAdapter {
  constructor() {
    this.labels = [];
    this.issues = [];
    this.nextNumber = 200;
    this.events = [];
    this.writes = [];
    this.failAuth = false;
  }

  checkCli() { this.events.push("checkCli"); }

  checkAuth() {
    this.events.push("checkAuth");
    if (this.failAuth) throw new Error("authentication failed");
  }

  async getRepository() {
    this.events.push("getRepository");
    return { nameWithOwner: repository, has_issues: true, permissions: { push: true } };
  }

  async getCommit() { this.events.push("getCommit"); return { sha: plan.plan.baseRevision }; }

  async listLabels() { this.events.push("listLabels"); return structuredClone(this.labels); }

  async createLabel(_repository, label) {
    this.events.push("createLabel");
    this.writes.push("createLabel");
    this.labels.push(structuredClone(label));
  }

  async updateLabel(_repository, name, label) {
    this.events.push("updateLabel");
    this.writes.push("updateLabel");
    this.labels = this.labels.filter((item) => item.name !== name).concat(structuredClone(label));
  }

  async listIssues() { this.events.push("listIssues"); return structuredClone(this.issues); }

  async createIssue(_repository, input) {
    this.events.push("createIssue");
    this.writes.push("createIssue");
    const number = this.nextNumber++;
    const issue = {
      ...structuredClone(input),
      number,
      node_id: `node-${number}`,
      html_url: `https://example.test/issues/${number}`,
      state: "open",
      labels: input.labels.map((name) => ({ name })),
    };
    this.issues.push(issue);
    return structuredClone(issue);
  }

  async updateIssue(_repository, number, input) {
    this.events.push("updateIssue");
    this.writes.push("updateIssue");
    const issue = this.issues.find((item) => item.number === number);
    Object.assign(issue, structuredClone(input));
    issue.labels = input.labels.map((name) => ({ name }));
    return structuredClone(issue);
  }

  async listSubIssues() { this.events.push("listSubIssues"); return []; }
  async listBlockedBy() { this.events.push("listBlockedBy"); return []; }
  async addSubIssue() { this.events.push("addSubIssue"); this.writes.push("addSubIssue"); }
  async removeSubIssue() { this.events.push("removeSubIssue"); this.writes.push("removeSubIssue"); }
  async addBlockedBy() { this.events.push("addBlockedBy"); this.writes.push("addBlockedBy"); }
  async removeBlockedBy() { this.events.push("removeBlockedBy"); this.writes.push("removeBlockedBy"); }
}

function args(command, extra = []) {
  return [command, "--plan", planFile, "--repo", repository, ...extra];
}

test("apply rejects an outdated approval digest before adapter access or writes", async () => {
  const adapter = new CliAdapter();
  await assert.rejects(() => execute(args("issues:apply", ["--approval-digest", "0".repeat(64)]), { adapter }), /digest mismatch/);
  assert.equal(adapter.events.length, 0);
  assert.equal(adapter.writes.length, 0);
});

test("repository mismatch is rejected before authentication", async () => {
  const adapter = new CliAdapter();
  await assert.rejects(() => execute(["issues:preview", "--plan", planFile, "--repo", "other/repository"], { adapter }), /repository mismatch/);
  assert.equal(adapter.events.length, 0);
});

test("authentication failure stops before any write", async () => {
  const adapter = new CliAdapter();
  adapter.failAuth = true;
  await assert.rejects(() => execute(args("issues:apply", ["--approval-digest", plan.approval.digest]), { adapter }), /authentication failed/);
  assert.deepEqual(adapter.writes, []);
  assert.deepEqual(adapter.events, ["checkCli", "checkAuth"]);
});

test("insufficient repository permission stops before any write", async () => {
  const adapter = new CliAdapter();
  adapter.getRepository = async () => {
    adapter.events.push("getRepository");
    return { nameWithOwner: repository, has_issues: true, permissions: { push: false } };
  };
  await assert.rejects(
    () => execute(args("issues:apply", ["--approval-digest", plan.approval.digest]), { adapter }),
    /Issues write permission/,
  );
  assert.equal(adapter.writes.length, 0);
  assert.ok(!adapter.events.includes("listLabels"));
});

test("missing base revision stops before any write", async () => {
  const adapter = new CliAdapter();
  adapter.getCommit = async () => {
    adapter.events.push("getCommit");
    throw new Error("HTTP 404 base revision not found");
  };
  await assert.rejects(
    () => execute(args("issues:apply", ["--approval-digest", plan.approval.digest]), { adapter }),
    /base revision not found/,
  );
  assert.equal(adapter.writes.length, 0);
  assert.ok(!adapter.events.includes("listIssues"));
});

test("preview is write-free and emits machine-readable JSON", async () => {
  const adapter = new CliAdapter();
  const output = [];
  const result = await execute(args("issues:preview"), { adapter, write: (value) => output.push(value) });
  assert.equal(adapter.writes.length, 0);
  assert.equal(result.preview, true);
  assert.equal(result.issues.length, 9);
  assert.equal(result.relationshipOperations.length, 15);
  assert.equal(result.relationshipPreviewIncomplete, true);
  assert.deepEqual(JSON.parse(output[0]).planId, "IWF-20260722");
});

test("apply performs all preflight reads before writes and returns Issue mapping", async () => {
  const adapter = new CliAdapter();
  const output = [];
  const result = await execute(args("issues:apply", ["--approval-digest", plan.approval.digest]), { adapter, write: (value) => output.push(value) });
  assert.equal(result.preview, false);
  assert.equal(result.issues.length, 9);
  assert.equal(result.relationshipOperations.length, 15);
  assert.equal(adapter.issues.length, 9);
  const firstWrite = adapter.events.findIndex((event) => event === "createLabel" || event === "createIssue");
  assert.ok(firstWrite > adapter.events.indexOf("getCommit"));
  assert.equal(JSON.parse(output[0]).issues.length, 9);
});

test("plan:validate remains offline and accepts the draft example", async () => {
  const output = [];
  const result = await execute(["plan:validate", "--plan", "examples/issue-plan.example.json"], { write: (value) => output.push(value) });
  assert.equal(result.status, "draft");
  assert.equal(JSON.parse(output[0]).valid, true);
});
