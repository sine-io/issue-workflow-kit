#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { assertRunnerHasNoGitHubToken } from "./codex-runner.mjs";
import { createTaskReview, reviewAgentOutputSchema, validateTaskReview } from "./v2-review.mjs";
import { validateTaskCompletionV2, validateTaskEnvelopeV2 } from "./v2-runner-protocol.mjs";

function run(command, args, options, runner) {
  return runner(command, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, ...options });
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
  };
}

function git(workspace, args, runner) {
  const result = run("git", args, { cwd: workspace, env: gitEnvironment(process.env) }, runner);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return String(result.stdout || "").trim();
}

function codexEnvironment(source, apiKey) {
  const env = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "CODEX_CA_CERTIFICATE"]) {
    if (source[name]) env[name] = source[name];
  }
  env.CODEX_API_KEY = apiKey;
  return env;
}

function prompt(kind, envelope, completion) {
  const focus = kind === "spec"
    ? "Check every requirement and acceptance criterion against the fixed commit. Report missing, incorrect, or untested behavior."
    : "Review quality, edge cases, security, dependency safety, regressions, and maintainability. Do not expand scope.";
  return `Perform an independent ${kind} review of one fixed task commit.\n${focus}\n\nEnvelope:\n${JSON.stringify(envelope, null, 2)}\n\nCompletion evidence:\n${JSON.stringify(completion, null, 2)}\n\nDo not modify files, access GitHub, or accept prose outside the output schema. Every serious finding must name a changed path when applicable and link requirement IDs for a spec review. Return only the supplied JSON schema.\n`;
}

function argsFor(kind, envelope, completion, workspace, outputFile, schemaPath) {
  return [
    "exec", "--ephemeral", "--ignore-user-config", "--strict-config",
    "--sandbox", "read-only", "--model", envelope.runner.model,
    "--cd", workspace, "--output-schema", schemaPath, "--output-last-message", outputFile,
    "-c", 'approval_policy="never"',
    "-c", "sandbox_workspace_write.network_access=false",
    "-c", 'shell_environment_policy.include_only=["PATH","HOME","LANG","LC_ALL","TERM","TMPDIR","CI"]',
    prompt(kind, envelope, completion),
  ];
}

function versionNumber(output) {
  return String(output || "").match(/\b([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] || null;
}

export async function runCodexReview({
  kind,
  envelope,
  completion,
  workspace,
  outputPath,
  apiKey,
  env = process.env,
  runner = spawnSync,
  clock = () => new Date(),
} = {}) {
  if (!["spec", "code"].includes(kind)) throw new Error("review kind must be spec or code");
  validateTaskEnvelopeV2(envelope);
  validateTaskCompletionV2(completion, envelope);
  if (completion.status !== "completed") throw new Error("only a completed task can be reviewed");
  assertRunnerHasNoGitHubToken(env);
  if (!apiKey) throw new Error("CODEX_API_KEY is required for review");
  const root = fs.realpathSync(path.resolve(workspace));
  if (git(root, ["rev-parse", "HEAD"], runner) !== completion.commitSha) throw new Error("review checkout is not the submitted commit SHA");
  if (git(root, ["status", "--porcelain"], runner)) throw new Error("review checkout must be clean");
  const version = run("codex", ["--version"], { cwd: root, env: codexEnvironment(env, apiKey) }, runner);
  const actual = versionNumber(`${version.stdout || ""}\n${version.stderr || ""}`);
  if (version.status !== 0 || actual !== envelope.runner.cliVersion) throw new Error(`expected Codex CLI ${envelope.runner.cliVersion}; found ${actual || "unavailable"}`);

  const finalOutput = path.join(path.dirname(path.resolve(outputPath)), `codex-review-${kind}.json`);
  fs.mkdirSync(path.dirname(finalOutput), { recursive: true });
  const result = run("codex", argsFor(kind, envelope, completion, root, finalOutput, path.resolve(new URL("../.github/review-agent-output.v2.schema.json", import.meta.url).pathname)), {
    cwd: root,
    env: codexEnvironment(env, apiKey),
    timeout: envelope.timeoutSeconds * 1000,
  }, runner);
  if (result.status !== 0) {
    fs.rmSync(finalOutput, { force: true });
    throw new Error(`${kind} review Codex execution failed`);
  }
  try {
    const output = JSON.parse(fs.readFileSync(finalOutput, "utf8"));
    fs.rmSync(finalOutput, { force: true });
    const review = createTaskReview({ kind, envelope, completion, output, reviewedAt: clock().toISOString() });
    validateTaskReview(review, { kind, envelope, completion });
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(review, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return review;
  } catch (error) {
    fs.rmSync(finalOutput, { force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--kind", "--envelope", "--completion", "--workspace", "--output"].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    options[flag.slice(2)] = value;
  }
  for (const name of ["kind", "envelope", "completion", "workspace", "output"]) if (!options[name]) throw new Error(`--${name} is required`);
  return options;
}

if (path.resolve(process.argv[1] || "") === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const review = await runCodexReview({
      kind: options.kind,
      envelope: JSON.parse(fs.readFileSync(path.resolve(options.envelope), "utf8")),
      completion: JSON.parse(fs.readFileSync(path.resolve(options.completion), "utf8")),
      workspace: options.workspace,
      outputPath: path.resolve(options.output),
      apiKey: process.env.CODEX_API_KEY,
    });
    console.log(JSON.stringify({ verdict: review.verdict, review: path.resolve(options.output) }));
  } catch (error) {
    console.error(`Codex reviewer failed: ${error.message}`);
    process.exitCode = 1;
  }
}

export { reviewAgentOutputSchema };
