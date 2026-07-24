import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { install } from "../scripts/v2-install.mjs";
import { publishPlan } from "../scripts/v2-publish.mjs";

const sourcePlan = JSON.parse(fs.readFileSync(new URL("../examples/issue-plan.v2.example.json", import.meta.url), "utf8"));
const sourceContract = fs.readFileSync(new URL("../examples/behavior-contract.v2.example.md", import.meta.url), "utf8");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "iwf-publish-"));
  const root = path.join(parent, "repo");
  const remote = path.join(parent, "remote.git");
  run("git", ["init", "-q", "-b", "main", root], parent);
  run("git", ["init", "-q", "--bare", remote], parent);
  run("git", ["config", "user.name", "Planner"], root);
  run("git", ["config", "user.email", "planner@example.test"], root);
  run("git", ["remote", "add", "origin", remote], root);
  install({ target: root, revision: "v2.0.0-alpha.1", cliVersion: "0.145.0", model: "gpt-5.6-sol" });
  run("git", ["add", "."], root);
  run("git", ["commit", "-qm", "install iwf"], root);
  run("git", ["push", "-q", "-u", "origin", "main"], root);
  const baseSha = run("git", ["rev-parse", "HEAD"], root);

  const directory = path.join(root, ".github/issue-plans/IWF-20260724-DEMO");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "behavior-contract.md"), sourceContract);
  const plan = structuredClone(sourcePlan);
  plan.$schema = "https://sine.io/issue-workflow-kit/iwf-plan.v2.schema.json";
  plan.repository = { owner: "acme", name: "example", defaultBranch: "main" };
  plan.plan.baseRevision = baseSha;
  plan.contract.path = "behavior-contract.md";
  const planFile = path.join(directory, "plan.json");
  fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  return { root, remote, baseSha, planFile, planPath: path.relative(root, planFile) };
}

class PublishAdapter {
  constructor(baseSha) {
    this.baseSha = baseSha;
    this.created = [];
    this.existing = [];
  }

  getRepository() {
    return { full_name: "acme/example", default_branch: "main" };
  }

  getBranch() {
    return { name: "main", commit: { sha: this.baseSha } };
  }

  getCommit() {
    return { sha: this.baseSha };
  }

  getAuthenticatedUser() {
    return { login: "planner" };
  }

  listPullRequests() {
    return this.existing;
  }

  createPullRequest(repository, value) {
    this.created.push({ repository, value });
    return { number: 17, state: "open", html_url: "https://example.test/pull/17" };
  }
}

test("plan publish seals the digest, commits only plan artifacts, and creates one planning PR", async () => {
  const fixtureData = fixture();
  const adapter = new PublishAdapter(fixtureData.baseSha);
  const preview = await publishPlan({
    root: fixtureData.root,
    planPath: fixtureData.planPath,
    adapter,
    dryRun: true,
    clock: () => new Date("2026-07-24T00:00:00Z"),
  });
  assert.equal(preview.dryRun, true);
  assert.equal(JSON.parse(fs.readFileSync(fixtureData.planFile)).approval.status, "draft");
  assert.equal(adapter.created.length, 0);

  const result = await publishPlan({
    root: fixtureData.root,
    planPath: fixtureData.planPath,
    adapter,
    clock: () => new Date("2026-07-24T00:00:00Z"),
  });
  assert.equal(result.pullRequest.number, 17);
  assert.equal(adapter.created.length, 1);
  assert.match(adapter.created[0].value.body, /sole human business approval/);
  assert.match(adapter.created[0].value.body, new RegExp(result.digest));
  const sealed = JSON.parse(fs.readFileSync(fixtureData.planFile));
  assert.deepEqual(sealed.approval, {
    status: "approved",
    digest: result.digest,
    approvedAt: "2026-07-24T00:00:00.000Z",
    approvedBy: "planner",
  });
  const changed = run("git", ["show", "--pretty=format:", "--name-only", "HEAD"], fixtureData.root).split("\n").filter(Boolean).sort();
  assert.deepEqual(changed, [
    ".github/issue-plans/IWF-20260724-DEMO/behavior-contract.md",
    ".github/issue-plans/IWF-20260724-DEMO/plan.json",
  ]);
  assert.match(run("git", ["--git-dir", fixtureData.remote, "show-ref", "refs/heads/iwf/plan-iwf-20260724-demo"], fixtureData.root), /refs\/heads\/iwf\/plan-iwf-20260724-demo/);

  adapter.existing = [{
    number: 17,
    state: "open",
    html_url: "https://example.test/pull/17",
    body: adapter.created[0].value.body,
    head: { sha: result.commitSha },
  }];
  const rerun = await publishPlan({ root: fixtureData.root, planPath: fixtureData.planPath, adapter });
  assert.equal(rerun.pullRequest.number, 17);
  assert.equal(adapter.created.length, 1);
});

test("plan publish performs no GitHub write when traceability validation fails", async () => {
  const fixtureData = fixture();
  const plan = JSON.parse(fs.readFileSync(fixtureData.planFile));
  plan.epics[0].tasks[0].requirementIds = ["REQ-999"];
  fs.writeFileSync(fixtureData.planFile, `${JSON.stringify(plan, null, 2)}\n`);
  const adapter = new PublishAdapter(fixtureData.baseSha);
  await assert.rejects(() => publishPlan({ root: fixtureData.root, planPath: fixtureData.planPath, adapter }), /unknown requirement/);
  assert.equal(adapter.created.length, 0);
});
