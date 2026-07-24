import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runDoctor } from "../scripts/v2-doctor.mjs";
import { install } from "../scripts/v2-install.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iwf-doctor-"));
  spawnSync("git", ["init", "-q", root]);
  install({ target: root, revision: "v2.0.0", cliVersion: "0.145.0", model: "gpt-5.6-sol" });
  return root;
}

function runner(command, args) {
  if (command === "git" && args[0] === "--version") return { status: 0, stdout: "git version 2.45.0\n", stderr: "" };
  if (command === "git" && args[0] === "remote") return { status: 0, stdout: "git@github.com:acme/example.git\n", stderr: "" };
  if (command === "gh") return { status: 0, stdout: "gh version 2.0.0\n", stderr: "" };
  if (command === "codex") return { status: 0, stdout: "codex-cli 0.145.0\n", stderr: "" };
  return { status: 1, stdout: "", stderr: "unexpected" };
}

class DoctorAdapter {
  getRepository() {
    return { full_name: "acme/example", default_branch: "main", has_issues: true, allow_auto_merge: true, permissions: { push: true } };
  }

  listActionsSecrets() {
    return [{ name: "IWF_TOKEN" }, { name: "CODEX_API_KEY" }];
  }

  getBranch() {
    return { name: "main" };
  }

  getBranchProtection() {
    return {
      required_status_checks: { strict: true, contexts: ["test"] },
      allow_force_pushes: { enabled: false },
    };
  }

  getActionsWorkflowPermissions() {
    return { default_workflow_permissions: "read" };
  }
}

test("doctor checks local runner, GitHub permissions, secrets, and branch protection without exposing values", async () => {
  const root = fixture();
  const token = "github_pat_secret-sentinel";
  const apiKey = "sk-secret-sentinel";
  const result = await runDoctor({
    root,
    adapter: new DoctorAdapter(),
    runner,
    env: { IWF_TOKEN: token, CODEX_API_KEY: apiKey },
  });
  assert.equal(result.healthy, true);
  assert.ok(result.checks.every((check) => check.status === "pass"));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(apiKey), false);
});

test("doctor reports exact failed gates and remains read-only", async () => {
  const root = fixture();
  class BrokenAdapter extends DoctorAdapter {
    getRepository() {
      return { full_name: "acme/example", default_branch: "main", has_issues: false, allow_auto_merge: false, permissions: { push: false } };
    }

    listActionsSecrets() {
      return [];
    }

    getBranchProtection() {
      return { required_status_checks: { contexts: [] }, allow_force_pushes: { enabled: true } };
    }
  }
  const result = await runDoctor({ root, adapter: new BrokenAdapter(), runner, env: {} });
  assert.equal(result.healthy, false);
  const failed = result.checks.filter((check) => check.status === "fail").map((check) => check.id);
  assert.ok(failed.includes("github-write"));
  assert.ok(failed.includes("issues"));
  assert.ok(failed.includes("auto-merge"));
  assert.ok(failed.includes("required-checks"));
  assert.ok(failed.includes("force-push"));
});
