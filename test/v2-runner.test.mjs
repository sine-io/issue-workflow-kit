import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { assertRunnerHasNoGitHubToken, codexArguments, runCodexTask } from "../scripts/codex-runner.mjs";
import {
  createTaskEnvelopeV2,
  validateTaskCompletionV2,
  validateTaskEnvelopeV2,
} from "../scripts/v2-runner-protocol.mjs";
import { v2PlanDigest, validateV2Plan } from "../scripts/v2-plan.mjs";

const planUrl = new URL("../examples/issue-plan.v2.example.json", import.meta.url);
const sourcePlan = JSON.parse(fs.readFileSync(planUrl, "utf8"));

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function workspace() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "iwf-runner-"));
  const root = path.join(parent, "worktree");
  fs.mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.test"]);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts/base.mjs"), "export const base = true;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  return { parent, root, baseRevision: git(root, ["rev-parse", "HEAD"]) };
}

function envelopeFor(baseRevision) {
  const plan = structuredClone(sourcePlan);
  plan.plan.baseRevision = baseRevision;
  plan.approval = {
    status: "approved",
    digest: v2PlanDigest(plan),
    approvedAt: "2026-07-24T00:00:00Z",
    approvedBy: "reviewer",
  };
  const validation = validateV2Plan(plan, { sourcePath: planUrl.pathname, requireApproval: true });
  return createTaskEnvelopeV2({
    plan,
    taskId: plan.epics[0].tasks[0].id,
    issue: { number: 42, url: "https://example.test/issues/42" },
    baseRevision,
    validation,
  });
}

function report(envelope, evidence = "Reviewed the changed behavior and focused test") {
  return {
    status: "completed",
    summary: "Implemented the approved task",
    acceptance: envelope.acceptance.map((criterion) => ({
      id: criterion.id,
      requirementId: criterion.requirementId,
      status: "success",
      evidence: [evidence],
    })),
    blockedReason: null,
  };
}

function fakeCodex(envelope, root, { file = "scripts/generated.mjs", content = "export const generated = true;\n", evidence, exitCode = 0, symlinkTarget, changeGitConfig = false } = {}) {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "git") return spawnSync(command, args, options);
    if (args[0] === "--version") return { status: 0, stdout: `codex-cli ${envelope.runner.cliVersion}\n`, stderr: "" };
    assert.equal(command, "codex");
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    if (symlinkTarget) fs.symlinkSync(symlinkTarget, path.join(root, file));
    else fs.writeFileSync(path.join(root, file), content);
    if (changeGitConfig) spawnSync("git", ["config", "--local", "iwf.runner-test", "changed"], { cwd: root });
    const output = args[args.indexOf("--output-last-message") + 1];
    fs.writeFileSync(output, JSON.stringify(report(envelope, evidence)));
    const events = envelope.verification.map((verification) => JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: verification.command, exit_code: exitCode },
    })).join("\n");
    return { status: 0, stdout: `${events}\n`, stderr: "" };
  };
  return { runner, calls };
}

test("v2 envelope binds repository, plan, requirements, Runner, and attempt", () => {
  const fixture = workspace();
  const envelope = envelopeFor(fixture.baseRevision);
  const validation = validateTaskEnvelopeV2(envelope);
  assert.equal(validation.digest.length, 64);
  assert.deepEqual(envelope.requirementIds, ["REQ-001"]);
  assert.equal(envelope.runner.model, "gpt-5.6-sol");
  assert.equal(envelope.attemptId.endsWith("-A01"), true);
  assert.equal(envelope.planBaseRevision, envelope.planBaseRevision.toLowerCase());
  const args = codexArguments(envelope, fixture.root, path.join(fixture.parent, "final.json"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("workspace-write"));
  assert.ok(args.includes("--output-schema"));
  assert.ok(args.includes("--ignore-user-config"));
  const tampered = structuredClone(envelope);
  tampered.requirements[0].id = "REQ-999";
  assert.throws(() => validateTaskEnvelopeV2(tampered), /requirements do not match/);
});

test("Codex runner accepts only structured acceptance plus real JSONL command exits and creates a local commit", async () => {
  const fixture = workspace();
  const envelope = envelopeFor(fixture.baseRevision);
  const fake = fakeCodex(envelope, fixture.root);
  const apiKey = "sk-test-secret-value";
  const outputPath = path.join(fixture.parent, "output/task-completion.json");
  const times = [new Date("2026-07-24T00:00:00Z"), new Date("2026-07-24T00:01:00Z")];
  const completion = await runCodexTask({
    envelope,
    workspace: fixture.root,
    outputPath,
    apiKey,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_API_KEY: apiKey },
    runner: fake.runner,
    clock: () => times.shift(),
  });
  assert.equal(completion.status, "completed");
  assert.match(completion.commitSha, /^[0-9a-f]{40}$/);
  assert.deepEqual(completion.changedFiles, [{ path: "scripts/generated.mjs", status: "added" }]);
  assert.equal(completion.verification.every((item) => item.status === "success"), true);
  assert.doesNotThrow(() => validateTaskCompletionV2(completion, envelope));
  assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), completion.commitSha);
  const codexCall = fake.calls.find((call) => call.args[0] === "exec");
  assert.equal(codexCall.options.env.CODEX_API_KEY, apiKey);
  assert.equal(Object.hasOwn(codexCall.options.env, "IWF_TOKEN"), false);
  assert.equal(fake.calls.filter((call) => call.command === "git").some((call) => Object.hasOwn(call.options.env, "CODEX_API_KEY")), false);
  const commitCall = fake.calls.find((call) => call.command === "git" && call.args.includes("commit"));
  assert.ok(commitCall);
  assert.deepEqual(commitCall.args.slice(0, 6), ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"]);
  assert.match(codexCall.args.join(" "), /shell_environment_policy\.include_only/);
  assert.equal(fs.existsSync(path.join(fixture.parent, "output/codex-final.json")), false);
  assert.equal(fs.readFileSync(outputPath, "utf8").includes(apiKey), false);
});

test("scope changes and missing command evidence block without committing", async () => {
  const fixture = workspace();
  const envelope = envelopeFor(fixture.baseRevision);
  const fake = fakeCodex(envelope, fixture.root, { file: "README.md" });
  const completion = await runCodexTask({
    envelope,
    workspace: fixture.root,
    outputPath: path.join(fixture.parent, "output/task-completion.json"),
    apiKey: "sk-test-secret-value",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    runner: fake.runner,
  });
  assert.equal(completion.status, "blocked");
  assert.equal(completion.block.kind, "scope");
  assert.equal(completion.commitSha, null);
  assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), fixture.baseRevision);
  assert.doesNotThrow(() => validateTaskCompletionV2(completion, envelope));
  const tampered = structuredClone(completion);
  tampered.block.retryable = true;
  assert.throws(() => validateTaskCompletionV2(tampered, envelope), /only a classified transient/);
});

test("secrets in Codex output are discarded and GitHub write tokens are refused", async () => {
  assert.throws(() => assertRunnerHasNoGitHubToken({ IWF_TOKEN: "github_pat_secret" }), /must not contain/);
  const fixture = workspace();
  const envelope = envelopeFor(fixture.baseRevision);
  const secret = "sk-output-secret-value";
  const fake = fakeCodex(envelope, fixture.root, { evidence: secret });
  const outputPath = path.join(fixture.parent, "output/task-completion.json");
  const completion = await runCodexTask({
    envelope,
    workspace: fixture.root,
    outputPath,
    apiKey: "sk-test-secret-value",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    runner: fake.runner,
  });
  assert.equal(completion.status, "blocked");
  assert.equal(completion.block.kind, "runner");
  assert.equal(JSON.stringify(completion).includes(secret), false);
  assert.equal(fs.readFileSync(outputPath, "utf8").includes(secret), false);
});

test("secrets written into a changed file block before a task commit", async () => {
  const fixture = workspace();
  const envelope = envelopeFor(fixture.baseRevision);
  const apiKey = "sk-file-secret-value";
  const fake = fakeCodex(envelope, fixture.root, { content: `export const leaked = "${apiKey}";\n` });
  const completion = await runCodexTask({
    envelope,
    workspace: fixture.root,
    outputPath: path.join(fixture.parent, "output/task-completion.json"),
    apiKey,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    runner: fake.runner,
  });
  assert.equal(completion.status, "blocked");
  assert.equal(completion.block.kind, "runner");
  assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), fixture.baseRevision);
});

test("symbolic links cannot escape the Runner workspace", async () => {
  const fixture = workspace();
  const envelope = envelopeFor(fixture.baseRevision);
  const outside = path.join(fixture.parent, "outside.txt");
  fs.writeFileSync(outside, "outside\n");
  const fake = fakeCodex(envelope, fixture.root, { symlinkTarget: outside });
  const completion = await runCodexTask({
    envelope,
    workspace: fixture.root,
    outputPath: path.join(fixture.parent, "output/task-completion.json"),
    apiKey: "sk-test-secret-value",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    runner: fake.runner,
  });
  assert.equal(completion.status, "blocked");
  assert.equal(completion.block.kind, "runner");
  assert.match(completion.block.reason, /symbolic link escapes/);
  assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), fixture.baseRevision);
});

test("Git metadata changes are blocked before the wrapper commit", async () => {
  const fixture = workspace();
  const envelope = envelopeFor(fixture.baseRevision);
  const fake = fakeCodex(envelope, fixture.root, { changeGitConfig: true });
  const completion = await runCodexTask({
    envelope,
    workspace: fixture.root,
    outputPath: path.join(fixture.parent, "output/task-completion.json"),
    apiKey: "sk-test-secret-value",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    runner: fake.runner,
  });
  assert.equal(completion.status, "blocked");
  assert.equal(completion.block.kind, "runner");
  assert.match(completion.block.reason, /Git metadata/);
  assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), fixture.baseRevision);
});
