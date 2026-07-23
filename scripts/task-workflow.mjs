#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { GitHubAdapter } from "./github-adapter.mjs";
import { preflight } from "./issue-workflow.mjs";
import { readPlan } from "./plan-validation.mjs";
import { readRuntimeJson } from "./runtime-validation.mjs";
import {
  blockTask,
  claimTask,
  heartbeatTask,
  reconcileTasks,
  resumeTask,
  submitTask,
} from "./task-runtime.mjs";

const COMMAND_OPTIONS = Object.freeze({
  "task:claim": ["task-id", "agent"],
  "task:heartbeat": ["attempt-id", "note?"],
  "task:block": ["attempt-id", "kind", "reason"],
  "task:resume": ["task-id", "from-attempt", "agent"],
  "task:submit": ["attempt-id", "pr", "result"],
  "task:reconcile": [],
});

const COMMON_OPTIONS = ["plan", "repo", "approval-digest"];

export class TaskCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskCliError";
  }
}

function optionKey(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function parseTaskArgs(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    throw new TaskCliError(`command must be one of ${Object.keys(COMMAND_OPTIONS).join(", ")}`);
  }
  const allowed = new Set([...COMMON_OPTIONS, ...COMMAND_OPTIONS[command].map((name) => name.replace(/\?$/, ""))]);
  const optional = new Set(COMMAND_OPTIONS[command].filter((name) => name.endsWith("?")).map((name) => name.slice(0, -1)));
  const options = { command };
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag.startsWith("--")) throw new TaskCliError(`unexpected positional argument: ${flag}`);
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new TaskCliError(`unknown argument for ${command}: ${flag}`);
    if (seen.has(name)) throw new TaskCliError(`duplicate argument: ${flag}`);
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) throw new TaskCliError(`${flag} requires a value`);
    seen.add(name);
    options[optionKey(name)] = value;
  }
  for (const name of COMMON_OPTIONS) {
    if (!seen.has(name)) throw new TaskCliError(`--${name} is required`);
  }
  for (const declared of COMMAND_OPTIONS[command]) {
    const name = declared.replace(/\?$/, "");
    if (!optional.has(name) && !seen.has(name)) throw new TaskCliError(`--${name} is required for ${command}`);
  }
  return options;
}

export async function executeTask(argv, {
  adapter = new GitHubAdapter(),
  write = (value) => console.log(value),
  clock,
  loadResult = readRuntimeJson,
  loadPlan = readPlan,
} = {}) {
  const options = parseTaskArgs(argv);
  const planPath = path.resolve(options.plan);
  const plan = loadPlan(planPath);
  const { validation } = await preflight({
    plan,
    repository: options.repo,
    adapter,
    expectedDigest: options.approvalDigest,
    sourcePath: planPath,
  });

  const common = { plan, repository: options.repo, adapter, clock };
  let commandResult;
  if (options.command === "task:claim") {
    commandResult = await claimTask({ ...common, taskId: options.taskId, agent: options.agent });
  } else if (options.command === "task:heartbeat") {
    commandResult = await heartbeatTask({ ...common, attemptId: options.attemptId, note: options.note });
  } else if (options.command === "task:block") {
    commandResult = await blockTask({
      ...common,
      attemptId: options.attemptId,
      kind: options.kind,
      reason: options.reason,
    });
  } else if (options.command === "task:resume") {
    commandResult = await resumeTask({
      ...common,
      taskId: options.taskId,
      fromAttempt: options.fromAttempt,
      agent: options.agent,
    });
  } else if (options.command === "task:submit") {
    const completion = loadResult(options.result);
    commandResult = await submitTask({
      ...common,
      attemptId: options.attemptId,
      pr: options.pr,
      result: completion,
    });
  } else {
    commandResult = await reconcileTasks(common);
  }

  const output = {
    command: options.command,
    repository: options.repo,
    planId: plan.plan.id,
    approvalDigest: validation.digest,
    ...commandResult,
  };
  write(JSON.stringify(output, null, 2));
  return output;
}

const entry = path.resolve(process.argv[1] || "");
if (entry === path.resolve(new URL(import.meta.url).pathname)) {
  executeTask(process.argv.slice(2)).catch((error) => {
    console.error(`task workflow failed: ${error.message}`);
    process.exitCode = 1;
  });
}
