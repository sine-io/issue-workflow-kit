import fs from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

import { approvalDigest, canonicalize } from "./plan-validation.mjs";
import {
  COMPLETION_SCHEMA_VERSION,
  EXECUTION_SCHEMA_VERSION,
  acceptanceRunId,
  attemptIdFor,
  envelopeDigest,
  isAllowedPath,
  runtimeDigest,
  verificationRunId,
} from "./runtime-domain.mjs";

const executionSchema = JSON.parse(fs.readFileSync(new URL("../.github/task-execution.schema.json", import.meta.url), "utf8"));
const completionSchema = JSON.parse(fs.readFileSync(new URL("../.github/task-completion.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("uri", {
  type: "string",
  validate(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  },
});
const validateExecutionSchema = ajv.compile(executionSchema);
const validateCompletionSchema = ajv.compile(completionSchema);

function schemaError(validator) {
  return (validator.errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

function recordFor(plan, taskId) {
  for (const epic of plan.epics) {
    const task = epic.tasks.find((candidate) => candidate.id === taskId);
    if (task) return task;
  }
  throw new Error(`task ${taskId} is not present in plan ${plan.plan.id}`);
}

function expectedRuns(taskId, task) {
  return {
    acceptance: task.acceptanceCriteria.map((_, index) => acceptanceRunId(taskId, index + 1)),
    verification: task.verificationSteps.map((_, index) => verificationRunId(taskId, index + 1)),
  };
}

function validatePaths(paths, allowedPaths, label) {
  const invalid = (paths || []).filter((filePath) => !isAllowedPath(filePath, allowedPaths));
  if (invalid.length) throw new Error(`${label} contains paths outside allowedPaths: ${invalid.join(", ")}`);
}

export function validateExecutionEnvelope(envelope, { plan, task } = {}) {
  if (!validateExecutionSchema(envelope)) throw new Error(`execution schema validation failed: ${schemaError(validateExecutionSchema)}`);
  const errors = [];
  if (new Set(envelope.acceptance.map((run) => run.id)).size !== envelope.acceptance.length) {
    errors.push("envelope acceptance run IDs must be unique");
  }
  if (new Set(envelope.verification.map((run) => run.id)).size !== envelope.verification.length) {
    errors.push("envelope verification run IDs must be unique");
  }
  for (const allowedPath of envelope.allowedPaths) {
    if (!isAllowedPath(allowedPath, [allowedPath])) errors.push(`envelope contains invalid allowedPath ${allowedPath}`);
  }
  if (plan) {
    if (envelope.planId !== plan.plan.id) errors.push(`envelope planId ${envelope.planId} does not match ${plan.plan.id}`);
    if (envelope.workflowRevision !== plan.workflow.revision) errors.push("envelope workflowRevision does not match plan");
    if (envelope.approvalDigest !== approvalDigest(plan)) errors.push("envelope approvalDigest does not match plan");
    const expectedTask = task || recordFor(plan, envelope.taskId);
    if (expectedTask.id !== envelope.taskId) errors.push("envelope taskId does not match task");
    validatePaths(envelope.allowedPaths, expectedTask.allowedPaths, "envelope allowedPaths");
    const expected = expectedRuns(envelope.taskId, expectedTask);
    if (JSON.stringify(envelope.acceptance.map((run) => run.id)) !== JSON.stringify(expected.acceptance)) {
      errors.push("envelope acceptance run IDs do not match task criteria");
    }
    if (JSON.stringify(envelope.verification.map((run) => run.id)) !== JSON.stringify(expected.verification)) {
      errors.push("envelope verification run IDs do not match task steps");
    }
    if (expectedTask.execution?.agent && expectedTask.execution.agent !== envelope.agent) {
      errors.push("envelope agent does not match approved execution agent");
    }
    if (expectedTask.execution?.commitPolicy && expectedTask.execution.commitPolicy !== envelope.commitPolicy) {
      errors.push("envelope commitPolicy does not match approved execution policy");
    }
  }
  if (envelope.attemptId !== attemptIdFor(envelope.taskId, envelope.attempt)) errors.push("attemptId does not match attempt");
  if (envelope.heartbeatIntervalSeconds > envelope.maxRuntimeSeconds) errors.push("heartbeat interval exceeds runtime limit");
  if (envelope.requiredChecks.some((check) => !check.trim())) errors.push("requiredChecks cannot contain blank values");
  if (errors.length) throw new Error(errors.join("; "));
  return { envelope, digest: envelopeDigest(envelope) };
}

function evidenceIds(values) {
  return new Set((values || []).map((entry) => entry.id));
}

export function validateCompletionResult(result, { envelope, plan, task } = {}) {
  if (!validateCompletionSchema(result)) throw new Error(`completion schema validation failed: ${schemaError(validateCompletionSchema)}`);
  const errors = [];
  const actualAcceptance = evidenceIds(result.acceptance);
  const actualVerification = evidenceIds(result.verification);
  if (actualAcceptance.size !== result.acceptance.length || actualVerification.size !== result.verification.length) {
    errors.push("completion evidence IDs must be unique");
  }
  if (envelope) {
    const envelopeResult = validateExecutionEnvelope(envelope, { plan, task });
    if (result.planId !== envelope.planId) errors.push("completion planId does not match envelope");
    if (result.taskId !== envelope.taskId) errors.push("completion taskId does not match envelope");
    if (result.issueNumber !== envelope.issueNumber) errors.push("completion issueNumber does not match envelope");
    if (result.attemptId !== envelope.attemptId) errors.push("completion attemptId does not match envelope");
    if (result.envelopeDigest !== envelopeResult.digest) errors.push("completion envelopeDigest does not match envelope");
    const expectedTask = task || (plan ? recordFor(plan, envelope.taskId) : {
      acceptanceCriteria: envelope.acceptance,
      verificationSteps: envelope.verification,
    });
    const expected = expectedRuns(envelope.taskId, expectedTask);
    for (const id of expected.acceptance) if (!actualAcceptance.has(id)) errors.push(`missing acceptance evidence ${id}`);
    for (const id of expected.verification) if (!actualVerification.has(id)) errors.push(`missing verification evidence ${id}`);
    for (const id of actualAcceptance) if (!expected.acceptance.includes(id)) errors.push(`unexpected acceptance evidence ${id}`);
    for (const id of actualVerification) if (!expected.verification.includes(id)) errors.push(`unexpected verification evidence ${id}`);
  }
  if (errors.length) throw new Error(errors.join("; "));
  return { result, digest: runtimeDigest(result) };
}

function repositoryName(ref) {
  return ref?.repo?.full_name || ref?.repo?.nameWithOwner || ref?.repository?.full_name || null;
}

export function pullRequestNumber(value) {
  if (Number.isInteger(value) && value > 0) return value;
  if (/^\d+$/.test(String(value || "")) && Number(value) > 0) return Number(value);
  const match = String(value || "").match(/\/pull\/(\d+)(?:[/?#]|$)/);
  if (!match) throw new Error("--pr must be a positive pull request number or URL");
  return Number(match[1]);
}

export function validatePullRequestSubmission({
  pr,
  files,
  envelope,
  issue,
  repository,
  defaultBranch,
  expectedNumber,
  allowMerged = false,
}) {
  const errors = [];
  const number = Number(pr?.number);
  if (!Number.isInteger(number) || number < 1) errors.push("pull request number is invalid");
  if (expectedNumber !== undefined && number !== Number(expectedNumber)) errors.push(`GitHub returned pull request #${number} instead of #${expectedNumber}`);
  const prOpen = String(pr?.state || "").toLowerCase() === "open";
  const prMerged = pr?.merged === true || Boolean(pr?.merged_at);
  if (!prOpen && !(allowMerged && prMerged)) errors.push("pull request must be open when submitted");
  const baseRepository = repositoryName(pr?.base);
  const headRepository = repositoryName(pr?.head);
  if (baseRepository?.toLowerCase() !== repository.toLowerCase()) errors.push("pull request base repository does not match target repository");
  if (headRepository?.toLowerCase() !== repository.toLowerCase()) errors.push("pull request head repository does not match target repository");
  if (typeof defaultBranch !== "string" || !defaultBranch) errors.push("target repository default branch is required");
  else if (pr?.base?.ref !== defaultBranch) errors.push(`pull request base branch must be ${defaultBranch}`);
  if (pr?.head?.ref !== envelope.branch) errors.push(`pull request head branch must be ${envelope.branch}`);
  if (typeof pr?.head?.sha !== "string" || !pr.head.sha) errors.push("pull request head SHA is required");
  const issueNumber = Number(issue?.number ?? envelope.issueNumber);
  const closePattern = new RegExp(`(?:^|\\s)Closes\\s+#${issueNumber}(?=\\s|[.,;:!?)]|$)`, "im");
  if (!closePattern.test(String(pr?.body || ""))) errors.push(`pull request body must contain Closes #${issueNumber}`);
  if (!Array.isArray(files) || files.length === 0) errors.push("pull request must contain at least one file");
  for (const file of files || []) {
    if (typeof file.filename !== "string" || !file.filename) {
      errors.push("pull request file is missing filename");
      continue;
    }
    const paths = [file.filename];
    if (file.status === "renamed" || file.previous_filename) paths.push(file.previous_filename);
    for (const filePath of paths.filter(Boolean)) {
      if (!isAllowedPath(filePath, envelope.allowedPaths)) errors.push(`pull request path is outside allowedPaths: ${filePath}`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
  return { number, headSha: pr.head?.sha, files: files.map((file) => file.filename) };
}

export function readRuntimeJson(file) {
  const source = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(file), "utf8");
  return JSON.parse(source);
}

export { canonicalize };
