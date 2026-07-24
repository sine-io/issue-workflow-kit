import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const selector = new URL("../scripts/select-active-plan.mjs", import.meta.url).pathname;

function writePlan(directory, name, approvedAt) {
  const target = path.join(directory, name);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "plan.json"), JSON.stringify({
    schemaVersion: "2.0",
    plan: { id: name },
    approval: { status: "approved", approvedAt },
  }));
}

test("active plan selection preserves old approvals and chooses the newest one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iwf-selection-"));
  const directory = path.join(root, ".github/issue-plans");
  writePlan(directory, "IWF-20260723-OLD", "2026-07-23T10:00:00Z");
  writePlan(directory, "IWF-20260724-NEW", "2026-07-24T10:00:00Z");
  const result = spawnSync(process.execPath, [selector, directory], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), ".github/issue-plans/IWF-20260724-NEW/plan.json");
});

test("active plan selection fails closed when no approved v2 plan exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iwf-selection-"));
  const directory = path.join(root, ".github/issue-plans");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "draft.json"), JSON.stringify({ schemaVersion: "2.0", approval: { status: "draft" } }));
  const result = spawnSync(process.execPath, [selector, directory], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at least one approved v2 plan/);
});
