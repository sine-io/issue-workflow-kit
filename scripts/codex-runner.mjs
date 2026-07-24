#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import { isAllowedPath } from "./runtime-domain.mjs";
import {
  agentOutputSchema,
  assertSafeRunnerText,
  validateAgentOutputV2,
  validateTaskCompletionV2,
  validateTaskEnvelopeV2,
  v2RuntimeDigest,
} from "./v2-runner-protocol.mjs";

const agentSchemaPath = path.resolve(new URL("../.github/task-agent-output.v2.schema.json", import.meta.url).pathname);
const transientPattern = /(?:rate.?limit|HTTP\s+(?:429|502|503|504)|ECONNRESET|ETIMEDOUT|timed out|temporarily unavailable)/i;
const credentialPattern = /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{8,})/;
const safeGitOptions = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

function run(command, args, options, runner) {
  return runner(command, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, ...options });
}

function git(workspace, args, runner, { allowFailure = false } = {}) {
  const result = run("git", [...safeGitOptions, ...args], { cwd: workspace, env: gitEnvironment(process.env) }, runner);
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return result;
}

function commandVersion(output) {
  return String(output || "").match(/\b([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] || null;
}

export function assertRunnerHasNoGitHubToken(env) {
  for (const name of ["IWF_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]) {
    if (env[name]) throw new Error(`Runner environment must not contain ${name}`);
  }
}

function codexEnvironment(source, apiKey) {
  const env = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "CODEX_CA_CERTIFICATE"]) {
    if (source[name]) env[name] = source[name];
  }
  env.CODEX_API_KEY = apiKey;
  return env;
}

function gitEnvironment(source) {
  const env = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI"]) if (source[name]) env[name] = source[name];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Issue Workflow Runner",
    GIT_AUTHOR_EMAIL: "issue-workflow-runner@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Issue Workflow Runner",
    GIT_COMMITTER_EMAIL: "issue-workflow-runner@users.noreply.github.com",
  };
}

function digestFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function snapshotNode(file, label, records, recurse = true) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) {
    records.push([label, "missing"]);
    return;
  }
  if (stat.isSymbolicLink()) {
    records.push([label, "symlink", fs.readlinkSync(file)]);
    return;
  }
  if (stat.isFile()) {
    records.push([label, "file", stat.mode, digestFile(file)]);
    return;
  }
  if (!stat.isDirectory()) {
    records.push([label, "other", stat.mode]);
    return;
  }
  records.push([label, "directory", stat.mode]);
  if (!recurse) return;
  for (const name of fs.readdirSync(file).sort()) snapshotNode(path.join(file, name), `${label}/${name}`, records);
}

function gitMetadataLocations(workspace, runner) {
  const gitDirectory = String(git(workspace, ["rev-parse", "--absolute-git-dir"], runner).stdout || "").trim();
  const commonValue = String(git(workspace, ["rev-parse", "--git-common-dir"], runner).stdout || "").trim();
  if (!gitDirectory || !commonValue) throw new Error("Runner could not resolve Git metadata paths");
  return {
    dotGit: path.join(workspace, ".git"),
    directories: [...new Set([gitDirectory, path.resolve(workspace, commonValue)])],
  };
}

function gitMetadataSnapshot(locations) {
  const records = [];
  snapshotNode(locations.dotGit, "worktree/.git", records, false);
  const protectedEntries = [
    "HEAD", "commondir", "config", "config.worktree", "gitdir", "hooks", "info",
    "objects/info", "packed-refs", "refs", "shallow",
  ];
  for (const [index, directory] of locations.directories.entries()) {
    snapshotNode(directory, `git-root-${index}`, records, false);
    for (const relative of protectedEntries) snapshotNode(path.join(directory, relative), `git-root-${index}/${relative}`, records);
  }
  return crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function gitIndexSnapshot(workspace, runner) {
  return String(git(workspace, ["ls-files", "--stage", "-v", "-z"], runner).stdout || "");
}

function runnerPrompt(envelope) {
  return `Implement exactly one approved Issue Workflow Kit task.\n\nTask envelope:\n${JSON.stringify(envelope, null, 2)}\n\nRules:\n- Work only in the current repository and only within allowedPaths.\n- Do not use GitHub APIs, push, open a pull request, merge, or change the plan.\n- Do not stage or commit files and do not modify Git metadata; the Runner wrapper owns the single task commit.\n- Follow repository instructions and preserve unrelated work.\n- Run every verification command exactly as written, as a standalone command.\n- If requirements conflict, a required path is outside allowedPaths, or verification cannot succeed, return blocked. Do not broaden scope.\n- Your final response must satisfy the supplied JSON Schema. Provide concrete requirement-linked acceptance evidence; prose outside that structure is not completion evidence.\n`;
}

function parseEvents(output) {
  const events = [];
  for (const line of String(output || "").split("\n").filter(Boolean)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error("Codex JSONL stream contained invalid JSON");
    }
  }
  return events;
}

function commandRecords(events) {
  return events
    .filter((event) => event.type === "item.completed" && event.item?.type === "command_execution")
    .map((event) => ({
      command: Array.isArray(event.item.command) ? event.item.command.join(" ") : String(event.item.command || ""),
      exitCode: Number.isInteger(event.item.exit_code) ? event.item.exit_code
        : Number.isInteger(event.item.exitCode) ? event.item.exitCode : null,
    }));
}

function commandMatches(actual, expected) {
  const normalized = actual.trim();
  if (normalized === expected.trim()) return true;
  for (const prefix of ["bash -lc ", "/bin/bash -lc ", "sh -lc ", "/bin/sh -lc "]) {
    if (!normalized.startsWith(prefix)) continue;
    const wrapped = normalized.slice(prefix.length).trim();
    if (wrapped === expected || wrapped === `'${expected.replaceAll("'", "'\\''")}'` || wrapped === JSON.stringify(expected)) return true;
  }
  return false;
}

function verificationEvidence(envelope, events) {
  const commands = commandRecords(events);
  return envelope.verification.map((verification) => {
    const record = [...commands].reverse().find((candidate) => commandMatches(candidate.command, verification.command));
    const status = record ? (record.exitCode === 0 ? "success" : "failed") : "missing";
    return {
      id: verification.id,
      requirementIds: [...verification.requirementIds],
      status,
      command: verification.command,
      exitCode: record?.exitCode ?? null,
      evidence: [record ? `Codex command event recorded exit code ${record.exitCode}` : "No exact Codex command event was recorded"],
    };
  });
}

function statusName(code) {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("R")) return "renamed";
  return "modified";
}

function changedFiles(workspace, baseRevision, runner) {
  const diff = git(workspace, ["diff", "--name-status", "--find-renames", baseRevision, "--"], runner).stdout;
  const files = [];
  for (const line of String(diff || "").split("\n").filter(Boolean)) {
    const [code, first, second] = line.split("\t");
    if (code.startsWith("R")) files.push({ path: second, status: "renamed", previousPath: first });
    else files.push({ path: first, status: statusName(code) });
  }
  const untracked = String(git(workspace, ["ls-files", "--others", "--exclude-standard"], runner).stdout || "")
    .split("\n").filter(Boolean);
  for (const file of untracked) if (!files.some((entry) => entry.path === file)) files.push({ path: file, status: "added" });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function pathsOutsideScope(files, allowedPaths) {
  return files.flatMap((file) => [file.path, file.previousPath].filter(Boolean))
    .filter((file) => !isAllowedPath(file, allowedPaths));
}

function assertChangedFilesContainNoCredentials(workspace, baseRevision, files, apiKey, runner) {
  for (const file of files) {
    const absolute = path.join(workspace, file.path);
    const fileType = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!fileType) continue;
    if (fileType.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      const resolvedTarget = path.resolve(path.dirname(absolute), target);
      const relativeTarget = path.relative(workspace, resolvedTarget);
      if (path.isAbsolute(target) || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
        throw new Error("a changed symbolic link escapes the Runner workspace");
      }
      if ((apiKey && target.includes(apiKey)) || credentialPattern.test(target)) {
        throw new Error("a changed symbolic link contains a possible credential");
      }
      continue;
    }
    if (!fileType.isFile()) continue;
    const text = fs.readFileSync(absolute).toString("utf8");
    if (apiKey && text.includes(apiKey)) throw new Error("changed files contain the Runner API credential");
    if (file.status === "added" && credentialPattern.test(text)) throw new Error("an added file contains a possible credential");
  }
  const diff = String(git(workspace, ["diff", "--unified=0", baseRevision, "--"], runner).stdout || "");
  const addedLines = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).join("\n");
  if (credentialPattern.test(addedLines)) throw new Error("changed lines contain a possible credential");
}

function fallbackAcceptance(envelope, evidence) {
  return envelope.acceptance.map((criterion) => ({
    id: criterion.id,
    requirementId: criterion.requirementId,
    status: "failed",
    evidence: [evidence],
  }));
}

function baseCompletion(envelope, startedAt, finishedAt) {
  return {
    schemaVersion: "task-completion/v2",
    planId: envelope.planId,
    planDigest: envelope.planDigest,
    taskId: envelope.taskId,
    attemptId: envelope.attemptId,
    envelopeDigest: v2RuntimeDigest(envelope),
    baseRevision: envelope.baseRevision,
    runner: structuredClone(envelope.runner),
    startedAt,
    finishedAt,
  };
}

function blockedCompletion({ envelope, startedAt, finishedAt, files, acceptance, verification, kind, reason, retryable }) {
  return {
    ...baseCompletion(envelope, startedAt, finishedAt),
    status: "blocked",
    commitSha: null,
    changedFiles: files,
    acceptance,
    verification,
    block: { kind, reason: assertSafeRunnerText(reason, "block reason"), retryable },
  };
}

function writeCompletion(outputPath, completion, envelope) {
  validateTaskCompletionV2(completion, envelope);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(completion, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, outputPath);
}

export function codexArguments(envelope, workspace, outputFile) {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--strict-config",
    "--sandbox", "workspace-write",
    "--model", envelope.runner.model,
    "--cd", workspace,
    "--json",
    "--output-schema", agentSchemaPath,
    "--output-last-message", outputFile,
    "-c", 'approval_policy="never"',
    "-c", "sandbox_workspace_write.network_access=false",
    "-c", 'shell_environment_policy.include_only=["PATH","HOME","LANG","LC_ALL","TERM","TMPDIR","CI"]',
    runnerPrompt(envelope),
  ];
}

export async function runCodexTask({
  envelope,
  workspace,
  outputPath,
  apiKey,
  env = process.env,
  runner = spawnSync,
  clock = () => new Date(),
} = {}) {
  validateTaskEnvelopeV2(envelope);
  assertRunnerHasNoGitHubToken(env);
  if (!apiKey) throw new Error("CODEX_API_KEY is required for the Codex invocation");
  const root = fs.realpathSync(path.resolve(workspace));
  if (!fs.statSync(path.join(root, ".git"), { throwIfNoEntry: false })) throw new Error("Runner workspace must be a Git checkout");
  const head = String(git(root, ["rev-parse", "HEAD"], runner).stdout || "").trim();
  if (head !== envelope.baseRevision) throw new Error(`Runner checkout must be at ${envelope.baseRevision}`);
  if (String(git(root, ["status", "--porcelain"], runner).stdout || "").trim()) throw new Error("Runner checkout must start clean");
  const versionResult = run("codex", ["--version"], { cwd: root, env: codexEnvironment(env, apiKey) }, runner);
  const actualVersion = commandVersion(`${versionResult.stdout || ""}\n${versionResult.stderr || ""}`);
  if (versionResult.status !== 0 || actualVersion !== envelope.runner.cliVersion) {
    throw new Error(`expected Codex CLI ${envelope.runner.cliVersion}; found ${actualVersion || "unavailable"}`);
  }

  const metadataLocations = gitMetadataLocations(root, runner);
  const metadataBefore = gitMetadataSnapshot(metadataLocations);
  const indexBefore = gitIndexSnapshot(root, runner);
  const startedAt = clock().toISOString();
  const finalOutput = path.join(path.dirname(path.resolve(outputPath)), "codex-final.json");
  fs.mkdirSync(path.dirname(finalOutput), { recursive: true });
  const result = run("codex", codexArguments(envelope, root, finalOutput), {
    cwd: root,
    env: codexEnvironment(env, apiKey),
    timeout: envelope.timeoutSeconds * 1000,
  }, runner);
  const finishedAt = clock().toISOString();
  let events = [];
  try {
    events = parseEvents(result.stdout);
  } catch {
    events = [];
  }
  const verification = verificationEvidence(envelope, events);
  let metadataChanged = false;
  try {
    metadataChanged = gitMetadataSnapshot(metadataLocations) !== metadataBefore
      || gitIndexSnapshot(root, runner) !== indexBefore;
  } catch {
    metadataChanged = true;
  }
  if (metadataChanged) {
    fs.rmSync(finalOutput, { force: true });
    const completion = blockedCompletion({
      envelope, startedAt, finishedAt, files: [],
      acceptance: fallbackAcceptance(envelope, "Codex changed protected Git metadata"),
      verification, kind: "runner", reason: "Codex changed protected Git metadata or the staging index", retryable: false,
    });
    writeCompletion(outputPath, completion, envelope);
    return completion;
  }
  let files = changedFiles(root, envelope.baseRevision, runner);

  if (result.error?.code === "ETIMEDOUT" || result.signal) {
    fs.rmSync(finalOutput, { force: true });
    const completion = blockedCompletion({
      envelope, startedAt, finishedAt, files,
      acceptance: fallbackAcceptance(envelope, "Codex timed out before producing acceptance evidence"),
      verification, kind: "timeout", reason: "Codex exceeded the approved task timeout", retryable: false,
    });
    writeCompletion(outputPath, completion, envelope);
    return completion;
  }
  if (result.status !== 0) {
    fs.rmSync(finalOutput, { force: true });
    const transient = transientPattern.test(`${result.stderr || ""}\n${result.stdout || ""}`);
    const completion = blockedCompletion({
      envelope, startedAt, finishedAt, files,
      acceptance: fallbackAcceptance(envelope, "Codex did not produce validated acceptance evidence"),
      verification,
      kind: transient ? "transient" : "runner",
      reason: transient ? "Codex failed because of a classified transient service error" : "Codex exited without a valid task result",
      retryable: transient && envelope.attempt < envelope.maxAttempts,
    });
    writeCompletion(outputPath, completion, envelope);
    return completion;
  }

  let agentOutput;
  try {
    const rawOutput = fs.readFileSync(finalOutput, "utf8");
    fs.rmSync(finalOutput, { force: true });
    agentOutput = validateAgentOutputV2(JSON.parse(rawOutput), envelope);
  } catch {
    fs.rmSync(finalOutput, { force: true });
    const completion = blockedCompletion({
      envelope, startedAt, finishedAt, files,
      acceptance: fallbackAcceptance(envelope, "Codex structured acceptance output failed validation"),
      verification, kind: "runner", reason: "Codex structured output failed validation", retryable: false,
    });
    writeCompletion(outputPath, completion, envelope);
    return completion;
  }

  const acceptance = structuredClone(agentOutput.acceptance);
  const outside = pathsOutsideScope(files, envelope.allowedPaths);
  if (outside.length) {
    const completion = blockedCompletion({
      envelope, startedAt, finishedAt, files, acceptance, verification,
      kind: "scope", reason: `Codex changed ${outside.length} path(s) outside allowedPaths`, retryable: false,
    });
    writeCompletion(outputPath, completion, envelope);
    return completion;
  }
  const verificationFailed = verification.some((entry) => entry.status !== "success");
  const acceptanceFailed = acceptance.some((entry) => entry.status !== "success");
  if (agentOutput.status === "blocked" || acceptanceFailed || verificationFailed || !files.length) {
    const kind = verificationFailed || !files.length ? "verification" : "requirement-conflict";
    const reason = agentOutput.status === "blocked"
      ? "Codex reported a requirement or implementation blocker"
      : verificationFailed ? "Required verification evidence is missing or failed"
        : acceptanceFailed ? "Acceptance evidence did not satisfy the approved requirement"
          : "Task produced no file changes";
    const completion = blockedCompletion({
      envelope, startedAt, finishedAt, files, acceptance, verification, kind, reason, retryable: false,
    });
    writeCompletion(outputPath, completion, envelope);
    return completion;
  }

  try {
    assertChangedFilesContainNoCredentials(root, envelope.baseRevision, files, apiKey, runner);
  } catch (error) {
    const completion = blockedCompletion({
      envelope, startedAt, finishedAt, files, acceptance, verification,
      kind: "runner", reason: error.message, retryable: false,
    });
    writeCompletion(outputPath, completion, envelope);
    return completion;
  }

  if (String(git(root, ["rev-parse", "HEAD"], runner).stdout || "").trim() !== envelope.baseRevision) {
    const completion = blockedCompletion({
      envelope, startedAt, finishedAt, files, acceptance, verification,
      kind: "runner", reason: "Codex created a commit before the Runner wrapper could validate it", retryable: false,
    });
    writeCompletion(outputPath, completion, envelope);
    return completion;
  }

  git(root, ["add", "--all", "--", "."], runner);
  const commit = run("git", [...safeGitOptions, "commit", "--no-gpg-sign", "-m", `task: ${envelope.taskId}`], {
    cwd: root,
    env: gitEnvironment(env),
  }, runner);
  if (commit.status !== 0) throw new Error("Runner could not create the task commit");
  const commitSha = String(git(root, ["rev-parse", "HEAD"], runner).stdout || "").trim();
  files = changedFiles(root, envelope.baseRevision, runner);
  const completion = {
    ...baseCompletion(envelope, startedAt, finishedAt),
    status: "completed",
    commitSha,
    changedFiles: files,
    acceptance,
    verification,
    block: null,
  };
  writeCompletion(outputPath, completion, envelope);
  return completion;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--envelope", "--workspace", "--output"].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    options[flag.slice(2)] = value;
  }
  for (const name of ["envelope", "workspace", "output"]) if (!options[name]) throw new Error(`--${name} is required`);
  return options;
}

if (path.resolve(process.argv[1] || "") === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const envelope = JSON.parse(fs.readFileSync(path.resolve(options.envelope), "utf8"));
    const completion = await runCodexTask({
      envelope,
      workspace: options.workspace,
      outputPath: path.resolve(options.output),
      apiKey: process.env.CODEX_API_KEY,
    });
    console.log(JSON.stringify({ status: completion.status, completion: path.resolve(options.output) }));
  } catch (error) {
    console.error(`Codex runner failed: ${error.message}`);
    process.exitCode = 1;
  }
}

export { agentOutputSchema };
