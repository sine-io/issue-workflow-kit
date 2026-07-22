#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { flattenPlan } from "./plan-domain.mjs";
import { syncIssues, syncRelationships } from "./issue-sync.mjs";
import { GitHubAdapter } from "./github-adapter.mjs";
import { readPlan, validatePlan } from "./plan-validation.mjs";

export class WorkflowCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowCliError";
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["plan:validate", "issues:preview", "issues:apply"].includes(command)) {
    throw new WorkflowCliError("command must be plan:validate, issues:preview, or issues:apply");
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--plan") options.plan = rest[++index];
    else if (value === "--repo") options.repo = rest[++index];
    else if (value === "--approval-digest") options.approvalDigest = rest[++index];
    else throw new WorkflowCliError(`unknown argument: ${value}`);
  }
  if (!options.plan) throw new WorkflowCliError("--plan is required");
  if (command !== "plan:validate" && !options.repo) throw new WorkflowCliError("--repo is required");
  if (command === "issues:apply" && !options.approvalDigest) {
    throw new WorkflowCliError("--approval-digest is required for issues:apply");
  }
  if (command !== "issues:apply" && options.approvalDigest) {
    throw new WorkflowCliError("--approval-digest is only valid for issues:apply");
  }
  return options;
}

function assertRepositoryName(value) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(value || "")) throw new WorkflowCliError("--repo must be owner/repository");
}

function canWriteIssues(repository) {
  const permissions = repository.permissions || {};
  return Boolean(permissions.push || permissions.maintain || permissions.admin)
    || ["WRITE", "MAINTAIN", "ADMIN"].includes(String(repository.viewerPermission || "").toUpperCase());
}

export async function preflight({ plan, repository, adapter, expectedDigest }) {
  const validation = validatePlan(plan, { requireApproval: true });
  if (expectedDigest !== undefined && expectedDigest !== validation.digest) {
    throw new WorkflowCliError(`approval digest mismatch: expected ${validation.digest}, got ${expectedDigest}`);
  }
  assertRepositoryName(repository);
  if (plan.workflow.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new WorkflowCliError(`repository mismatch: plan targets ${plan.workflow.repository}, command targets ${repository}`);
  }

  adapter.checkCli();
  adapter.checkAuth();
  const repositoryInfo = await adapter.getRepository(repository);
  const actualName = repositoryInfo.nameWithOwner || `${repositoryInfo.owner?.login || repositoryInfo.owner?.name || ""}/${repositoryInfo.name}`;
  if (actualName && actualName.toLowerCase() !== repository.toLowerCase()) {
    throw new WorkflowCliError(`GitHub returned a different repository: ${actualName}`);
  }
  if (repositoryInfo.has_issues === false) throw new WorkflowCliError("target repository has Issues disabled");
  if (!canWriteIssues(repositoryInfo)) throw new WorkflowCliError("token does not have repository Issues write permission");
  await adapter.getCommit(repository, plan.plan.baseRevision);
  return { validation, repositoryInfo };
}

function plannedRelationshipOperations(plan) {
  const records = flattenPlan(plan, { validate: false });
  const operations = [];
  for (const task of records.filter((record) => record.kind === "task")) {
    operations.push({ action: "add-sub-issue", parentId: task.parentId, childId: task.id });
    for (const blockingId of task.dependsOn) operations.push({ action: "add-dependency", issueId: task.id, blockingId });
  }
  return operations;
}

function serializableIssueResult(result) {
  return result.issues.map((issue) => ({
    id: issue.id,
    number: issue.number,
    url: issue.url,
    created: issue.created,
    updated: issue.updated,
  }));
}

export async function execute(argv, { adapter = new GitHubAdapter(), write = (value) => console.log(value) } = {}) {
  const options = parseArgs(argv);
  const plan = readPlan(path.resolve(options.plan));
  if (options.command === "plan:validate") {
    const validation = validatePlan(plan);
    const result = {
      valid: true,
      planId: plan.plan.id,
      digest: validation.digest,
      status: plan.approval.status,
      epics: plan.epics.length,
      tasks: plan.epics.reduce((count, epic) => count + epic.tasks.length, 0),
    };
    write(JSON.stringify(result, null, 2));
    return result;
  }

  const preview = options.command === "issues:preview";
  const { validation } = await preflight({
    plan,
    repository: options.repo,
    adapter,
    expectedDigest: options.approvalDigest,
  });
  const issueResult = await syncIssues({ plan, repository: options.repo, adapter, preview });
  let relationshipResult;
  const hasMissingIssue = issueResult.issues.some((issue) => issue.number === null);
  if (preview && hasMissingIssue) {
    relationshipResult = {
      preview: true,
      operations: plannedRelationshipOperations(plan),
      incomplete: true,
      refs: new Map(),
    };
  } else {
    relationshipResult = await syncRelationships({
      plan,
      repository: options.repo,
      adapter,
      preview,
      refs: issueResult.refs,
    });
  }
  const result = {
    command: options.command,
    repository: options.repo,
    planId: plan.plan.id,
    approvalDigest: validation.digest,
    preview,
    issues: serializableIssueResult(issueResult),
    issueOperations: issueResult.operations,
    relationshipOperations: relationshipResult.operations,
    relationshipPreviewIncomplete: Boolean(relationshipResult.incomplete),
  };
  write(JSON.stringify(result, null, 2));
  return result;
}

const entry = path.resolve(process.argv[1] || "");
if (entry === path.resolve(new URL(import.meta.url).pathname)) {
  execute(process.argv.slice(2)).catch((error) => {
    console.error(`issue workflow failed: ${error.message}`);
    process.exitCode = 1;
  });
}
