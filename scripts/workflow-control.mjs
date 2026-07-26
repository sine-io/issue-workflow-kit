#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { GitHubAdapter } from "./github-adapter.mjs";
import {
  claimNextTask,
  blockReviewV2,
  preflightTaskSubmissionV2,
  reconcileV2,
  recordReviewV2,
  submitTaskV2,
} from "./v2-control.mjs";
import { readV2Plan, validateV2Plan } from "./v2-plan.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["prepare", "submit", "record-review", "block-review", "merge", "reconcile"].includes(command)) throw new Error("workflow command must be prepare, submit, record-review, block-review, merge, or reconcile");
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!["--plan", "--repo", "--envelope", "--completion", "--bundle", "--review", "--reason"].includes(flag)) throw new Error(`unknown workflow argument ${flag}`);
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    options[flag.slice(2)] = value;
  }
  for (const name of ["plan", "repo"]) if (!options[name]) throw new Error(`--${name} is required`);
  if (command === "prepare" && !options.envelope) throw new Error("--envelope is required for prepare");
  if (command === "submit" && (!options.envelope || !options.completion || !options.bundle)) throw new Error("submit requires --envelope, --completion, and --bundle");
  if (command === "record-review" && (!options.envelope || !options.completion || !options.review)) throw new Error("record-review requires --envelope, --completion, and --review");
  if (command === "block-review" && (!options.envelope || !options.completion)) throw new Error("block-review requires --envelope and --completion");
  if (command === "merge" && (!options.envelope || !options.completion)) throw new Error("merge requires --envelope and --completion");
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function rootOf(planFile) {
  const absolute = path.resolve(planFile);
  const marker = `${path.sep}.github${path.sep}issue-plans${path.sep}`;
  const index = absolute.lastIndexOf(marker);
  return index === -1 ? process.cwd() : absolute.slice(0, index);
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

export function mergeNeedsAnotherReconcile(result) {
  return result?.reports?.at(-1)?.status === "merge-requested";
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function reconcileForMerge({
  plan,
  planPath,
  repository,
  adapter,
  reconcile = reconcileV2,
  pause = wait,
  pollIntervalMs = 15_000,
  maxPolls = 120,
}) {
  let result;
  for (let poll = 0; poll <= maxPolls; poll += 1) {
    result = await reconcile({ plan, planPath, repository, adapter, sync: false });
    const status = result?.reports?.at(-1)?.status;
    if (status === "merge-requested") continue;
    if (status !== "pending" || poll === maxPolls) return result;
    await pause(pollIntervalMs);
  }
  return result;
}

async function main(argv) {
  const options = parseArgs(argv);
  const planPath = path.resolve(options.plan);
  const plan = readV2Plan(planPath);
  const validation = validateV2Plan(plan, { sourcePath: planPath, requireApproval: true });
  const adapter = new GitHubAdapter({ retries: 2 });
  const root = rootOf(planPath);
  if (options.command === "prepare") {
    let reconciled = await reconcileV2({ plan, planPath, repository: options.repo, adapter, sync: true });
    if (reconciled.reports?.at(-1)?.status === "merge-requested") {
      reconciled = await reconcileV2({ plan, planPath, repository: options.repo, adapter, sync: false });
    }
    const current = reconciled.reports?.at(-1);
    if (["pending", "merge-requested", "in-progress", "in-review"].includes(current?.status)) {
      return {
        status: "stopped",
        reason: `current task is ${current.status}`,
        planId: plan.plan.id,
        planDigest: validation.digest,
        reconciliation: current,
      };
    }
    if (reconciled.status === "complete") {
      return { status: "complete", reason: "all tasks are closed", planId: plan.plan.id, planDigest: validation.digest };
    }
    const result = await claimNextTask({ plan, planPath, repository: options.repo, adapter, agent: "codex", baseRevision: (await adapter.getBranch(options.repo, plan.repository.defaultBranch)).commit?.sha });
    if (result.envelope) fs.writeFileSync(path.resolve(options.envelope), `${JSON.stringify(result.envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { ...result, planId: plan.plan.id, planDigest: validation.digest };
  }
  if (options.command === "submit") {
    const envelope = readJson(options.envelope);
    const completion = readJson(options.completion);
    await preflightTaskSubmissionV2({ plan, planPath, repository: options.repo, adapter, envelope, completion });
    if (completion.status === "completed") {
      git(root, ["bundle", "verify", options.bundle]);
      git(root, ["fetch", options.bundle, `refs/heads/${envelope.branch}`]);
      if (git(root, ["rev-parse", "FETCH_HEAD"]) !== completion.commitSha) throw new Error("Git bundle head does not match task completion");
      git(root, ["push", "origin", `${completion.commitSha}:refs/heads/${envelope.branch}`]);
    }
    return submitTaskV2({ plan, planPath, repository: options.repo, adapter, envelope, completion });
  }
  if (options.command === "record-review") {
    const envelope = readJson(options.envelope);
    const completion = readJson(options.completion);
    const review = readJson(options.review);
    return recordReviewV2({ plan, planPath, repository: options.repo, adapter, envelope, completion, issueNumber: envelope.issueNumber, review });
  }
  if (options.command === "block-review") {
    const envelope = readJson(options.envelope);
    const completion = readJson(options.completion);
    return blockReviewV2({ plan, planPath, repository: options.repo, adapter, envelope, completion, reason: options.reason });
  }
  if (options.command === "merge") {
    const envelope = readJson(options.envelope);
    const completion = readJson(options.completion);
    const merged = await reconcileForMerge({ plan, planPath, repository: options.repo, adapter });
    if (merged.reports?.some((report) => report.status === "complete" && report.changed)) {
      await adapter.dispatchWorkflow(options.repo, ".github/workflows/issue-workflow.yml", { ref: plan.repository.defaultBranch });
    }
    return { ...merged, planId: plan.plan.id, planDigest: validation.digest };
  }
  return reconcileV2({ plan, planPath, repository: options.repo, adapter, sync: true });
}

if (path.resolve(process.argv[1] || "") === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result?.stopped || ["stopped", "superseded", "blocked"].includes(result?.status)) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(`workflow control failed: ${error.message}`);
      process.exitCode = 1;
    });
}

export { parseArgs as parseWorkflowControlArgs, main as executeWorkflowControl };
