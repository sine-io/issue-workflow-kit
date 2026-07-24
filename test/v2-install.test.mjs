import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { executeIwf, parseIwfArgs } from "../scripts/v2-cli.mjs";
import { readConfig } from "../scripts/v2-config.mjs";
import { install } from "../scripts/v2-install.mjs";

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iwf-install-"));
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  return root;
}

const options = {
  revision: "v2.0.0-alpha.1",
  cliVersion: "0.145.0",
  model: "gpt-5.6-sol",
};

test("init installs only the minimum target surface and is idempotent", () => {
  const root = repository();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "target-owned\n");
  fs.writeFileSync(path.join(root, "README.md"), "existing\n");
  const first = install({ target: root, ...options });
  assert.deepEqual(first.operations.map(({ path: file, action }) => [file, action]), [
    [".github/issue-workflow.yml", "create"],
    [".github/workflows/issue-workflow.yml", "create"],
    [".codex/skills/iwf-plan/SKILL.md", "create"],
    [".codex/skills/iwf-plan/agents/openai.yaml", "create"],
    [".github/issue-plans/.gitkeep", "create"],
  ]);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "target-owned\n");
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "existing\n");
  assert.equal(readConfig(path.join(root, ".github/issue-workflow.yml")).kit.revision, options.revision);
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/issue-workflow.yml"), "utf8");
  assert.match(workflow, /issue-workflow-v2\.yml@v2\.0\.0-alpha\.1/);
  assert.match(workflow, /kit_repository: sine-io\/issue-workflow-kit/);
  assert.match(workflow, /kit_revision: v2\.0\.0-alpha\.1/);
  assert.match(workflow, /codex_version: 0\.145\.0/);
  assert.match(workflow, /secrets\.IWF_TOKEN/);
  assert.match(workflow, /secrets\.CODEX_API_KEY/);

  const second = install({ target: root, ...options });
  assert.ok(second.operations.every(({ action }) => action === "unchanged"));
});

test("init detects every conflict before writing and replaces only with explicit force", () => {
  const root = repository();
  const config = path.join(root, ".github/issue-workflow.yml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, "owned: true\n");
  assert.throws(() => install({ target: root, ...options }), /would overwrite/);
  assert.equal(fs.existsSync(path.join(root, ".github/workflows/issue-workflow.yml")), false);
  const preview = install({ target: root, ...options, force: true, dryRun: true });
  assert.equal(preview.operations.find(({ path: file }) => file === ".github/issue-workflow.yml").action, "replace");
  assert.equal(fs.readFileSync(config, "utf8"), "owned: true\n");
  install({ target: root, ...options, force: true });
  assert.equal(readConfig(config).schemaVersion, "iwf-config/v2");
});

test("init never follows an installation destination symbolic link", () => {
  const root = repository();
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "iwf-outside-")), "owned.yml");
  fs.writeFileSync(outside, "outside-owned\n");
  const config = path.join(root, ".github/issue-workflow.yml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.symlinkSync(outside, config);
  assert.throws(() => install({ target: root, ...options, force: true }), /refuses symbolic-link/);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside-owned\n");
  assert.equal(fs.existsSync(path.join(root, ".github/workflows/issue-workflow.yml")), false);
});

test("init refuses symbolic-link parent directories before writing", () => {
  const root = repository();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "iwf-parent-outside-"));
  fs.symlinkSync(outside, path.join(root, ".github"));
  assert.throws(() => install({ target: root, ...options }), /refuses symbolic-link/);
  assert.equal(fs.readdirSync(outside).length, 0);
});

test("CLI requires pinned versions, rejects unknown flags, and emits JSON", async () => {
  assert.throws(() => parseIwfArgs(["init", "--wat", "value"]), /unknown argument/);
  const help = [];
  assert.deepEqual(parseIwfArgs(["--help"]), { command: "help" });
  assert.deepEqual(await executeIwf(["--help"], { write: (value) => help.push(value) }), { help: true });
  assert.match(help[0], /Usage: iwf <command>/);
  const root = repository();
  const output = [];
  await executeIwf([
    "init", "--target", root, "--ref", options.revision,
    "--codex-version", options.cliVersion, "--model", options.model,
  ], { write: (value) => output.push(value) });
  const result = JSON.parse(output[0]);
  assert.equal(result.command, "init");
  assert.equal(result.config.kit.revision, options.revision);
});
