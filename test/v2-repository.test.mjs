import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { install } from "../scripts/v2-install.mjs";
import { v2PlanDigest } from "../scripts/v2-plan.mjs";
import { validateRepository } from "../scripts/v2-repository.mjs";

const sourcePlan = JSON.parse(fs.readFileSync(new URL("../examples/issue-plan.v2.example.json", import.meta.url), "utf8"));
const sourceContract = fs.readFileSync(new URL("../examples/behavior-contract.v2.example.md", import.meta.url), "utf8");

function fixture({ approved = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iwf-repository-"));
  spawnSync("git", ["init", "-q", "-b", "main", root]);
  install({ target: root, revision: "v2.0.0-alpha.1", cliVersion: "0.145.0", model: "gpt-5.6-sol" });
  const directory = path.join(root, ".github/issue-plans/IWF-20260724-DEMO");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "behavior-contract.md"), sourceContract);
  const plan = structuredClone(sourcePlan);
  plan.$schema = "https://sine.io/issue-workflow-kit/iwf-plan.v2.schema.json";
  plan.contract.path = "behavior-contract.md";
  if (approved) {
    plan.approval = {
      status: "approved",
      digest: v2PlanDigest(plan),
      approvedAt: "2026-07-24T00:00:00Z",
      approvedBy: "reviewer",
    };
  }
  fs.writeFileSync(path.join(directory, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  return { root, planPath: ".github/issue-plans/IWF-20260724-DEMO/plan.json" };
}

function commit(root, message) {
  spawnSync("git", ["add", "."], { cwd: root });
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", message], { cwd: root });
  assert.equal(result.status, 0, result.stderr?.toString());
}

test("repository validation checks config, contract, traceability, and plan digest", () => {
  const { root, planPath } = fixture();
  const result = validateRepository({ root, planPath });
  assert.equal(result.valid, true);
  assert.equal(result.plans[0].requirements, 2);
  assert.equal(result.plans[0].tasks, 2);

  const configPath = path.join(root, ".github/issue-workflow.yml");
  const config = fs.readFileSync(configPath, "utf8").replace("model: gpt-5.6-sol", "model: another-model");
  fs.writeFileSync(configPath, config);
  assert.throws(() => validateRepository({ root, planPath }), /runner.model differs/);
});

test("validation refuses any edit to a previously approved plan", () => {
  const { root, planPath } = fixture({ approved: true });
  commit(root, "approved plan");
  const absolute = path.join(root, planPath);
  const plan = JSON.parse(fs.readFileSync(absolute, "utf8"));
  plan.plan.title = "silently changed";
  fs.writeFileSync(absolute, `${JSON.stringify(plan, null, 2)}\n`);
  assert.throws(() => validateRepository({ root, planPath, baseRef: "HEAD" }), /approved plan is immutable/);
});

test("targeted validation cannot hide edits to another approved plan", () => {
  const { root, planPath } = fixture({ approved: true });
  const firstDirectory = path.dirname(path.join(root, planPath));
  const secondDirectory = path.join(root, ".github/issue-plans/IWF-20260724-OTHER");
  fs.cpSync(firstDirectory, secondDirectory, { recursive: true });
  const secondPlanPath = path.join(secondDirectory, "plan.json");
  const secondPlan = JSON.parse(fs.readFileSync(secondPlanPath, "utf8"));
  secondPlan.plan.id = "IWF-20260724-OTHER";
  secondPlan.plan.title = "Other approved plan";
  secondPlan.approval.digest = v2PlanDigest(secondPlan);
  fs.writeFileSync(secondPlanPath, `${JSON.stringify(secondPlan, null, 2)}\n`);
  commit(root, "add second approved plan");
  secondPlan.plan.title = "silently changed other plan";
  fs.writeFileSync(secondPlanPath, `${JSON.stringify(secondPlan, null, 2)}\n`);
  assert.throws(() => validateRepository({ root, planPath, baseRef: "HEAD" }), /approved plan is immutable/);
});

test("task scope cannot include its approved plan or behavior contract", () => {
  const { root, planPath } = fixture();
  const absolute = path.join(root, planPath);
  const plan = JSON.parse(fs.readFileSync(absolute, "utf8"));
  plan.epics[0].tasks[0].allowedPaths.push(".github/**");
  fs.writeFileSync(absolute, `${JSON.stringify(plan, null, 2)}\n`);
  assert.throws(() => validateRepository({ root, planPath }), /cannot include approved plan artifact/);
});

test("repository validation refuses reuse of a stable plan ID", () => {
  const { root, planPath } = fixture();
  const sourceDirectory = path.dirname(path.join(root, planPath));
  const duplicateDirectory = path.join(root, ".github/issue-plans/duplicate");
  fs.cpSync(sourceDirectory, duplicateDirectory, { recursive: true });
  assert.throws(() => validateRepository({ root, planPath }), /plan ID .* is reused/);
});

test("repository validation refuses swapped caller secrets", () => {
  const { root, planPath } = fixture();
  const caller = path.join(root, ".github/workflows/issue-workflow.yml");
  const source = fs.readFileSync(caller, "utf8")
    .replace("IWF_TOKEN: ${{ secrets.IWF_TOKEN }}", "IWF_TOKEN: ${{ secrets.CODEX_API_KEY }}");
  fs.writeFileSync(caller, source);
  assert.throws(() => validateRepository({ root, planPath }), /map each split secret/);
});
