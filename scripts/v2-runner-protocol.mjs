import crypto from "node:crypto";
import fs from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

import { isAllowedPath } from "./runtime-domain.mjs";
import { canonicalizeV2, flattenV2Plan, v2PlanDigest } from "./v2-plan.mjs";

const envelopeSchema = JSON.parse(fs.readFileSync(new URL("../.github/task-envelope.v2.schema.json", import.meta.url), "utf8"));
const completionSchema = JSON.parse(fs.readFileSync(new URL("../.github/task-completion.v2.schema.json", import.meta.url), "utf8"));
const agentOutputSchema = JSON.parse(fs.readFileSync(new URL("../.github/task-agent-output.v2.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("uri", {
  type: "string",
  validate: (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  },
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value) => !Number.isNaN(Date.parse(value)) && /Z$/.test(value),
});
const validateEnvelopeSchema = ajv.compile(envelopeSchema);
const validateCompletionSchema = ajv.compile(completionSchema);
const validateAgentOutputSchema = ajv.compile(agentOutputSchema);

export const TASK_ENVELOPE_VERSION = "task-envelope/v2";
export const TASK_COMPLETION_VERSION = "task-completion/v2";

function errorsFor(validator) {
  return (validator.errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

export function v2RuntimeDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalizeV2(value)), "utf8").digest("hex");
}

export function v2AttemptId(taskId, attempt) {
  return `${taskId}-A${String(attempt).padStart(2, "0")}`;
}

export function v2TaskBranch(taskId, attempt) {
  return `iwf/${taskId.toLowerCase()}-a${attempt}`;
}

function issueFields(issue) {
  const issueNumber = Number(issue?.number);
  const issueUrl = issue?.html_url || issue?.url;
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("task Issue number is required");
  if (!issueUrl) throw new Error("task Issue URL is required");
  return { issueNumber, issueUrl };
}

export function v2Task(plan, taskId) {
  const record = flattenV2Plan(plan).find((candidate) => candidate.kind === "task" && candidate.id === taskId);
  if (!record) throw new Error(`task ${taskId} is not in plan ${plan.plan.id}`);
  return record;
}

export function createTaskEnvelopeV2({ plan, taskId, task, issue, baseRevision, attempt = 1, validation }) {
  const record = task || v2Task(plan, taskId);
  if (!validation || validation.digest !== v2PlanDigest(plan)) throw new Error("validated immutable plan digest is required");
  if (!/^[0-9a-f]{40}$/.test(baseRevision)) throw new Error("task baseRevision must be a full lowercase commit SHA");
  if (plan.plan.baseRevision !== plan.plan.baseRevision.toLowerCase()) throw new Error("plan baseRevision must be lowercase");
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > record.execution.maxAttempts) {
    throw new Error(`attempt must be between 1 and ${record.execution.maxAttempts}`);
  }
  const requirements = plan.requirements
    .filter((requirement) => record.requirementIds.includes(requirement.id))
    .map(({ id, title, behavior, boundaries, exceptions, unacceptableBehavior }) => ({
      id, title, behavior, boundaries: [...boundaries], exceptions: [...exceptions], unacceptableBehavior: [...unacceptableBehavior],
    }));
  return {
    schemaVersion: TASK_ENVELOPE_VERSION,
    repository: `${plan.repository.owner}/${plan.repository.name}`,
    defaultBranch: plan.repository.defaultBranch,
    baseRevision,
    planBaseRevision: plan.plan.baseRevision.toLowerCase(),
    planId: plan.plan.id,
    planDigest: validation.digest,
    contractDigest: validation.contractDigest,
    workflowRevision: plan.workflow.revision,
    taskId: record.id,
    ...issueFields(issue),
    branch: v2TaskBranch(record.id, attempt),
    title: record.title,
    goal: record.goal,
    expectedBehavior: record.expectedBehavior,
    outOfScope: [...record.outOfScope],
    requirementIds: [...record.requirementIds],
    requirements,
    allowedPaths: [...record.allowedPaths],
    acceptance: structuredClone(record.acceptanceCriteria),
    verification: structuredClone(record.verificationSteps),
    attemptId: v2AttemptId(record.id, attempt),
    attempt,
    maxAttempts: record.execution.maxAttempts,
    timeoutSeconds: record.execution.maxRuntimeSeconds,
    requiredChecks: [...record.execution.requiredChecks],
    runner: structuredClone(plan.runner),
  };
}

function same(left, right) {
  return JSON.stringify(canonicalizeV2(left)) === JSON.stringify(canonicalizeV2(right));
}

export function validateTaskEnvelopeV2(envelope, { plan, task, validation } = {}) {
  if (!validateEnvelopeSchema(envelope)) throw new Error(`task envelope schema validation failed: ${errorsFor(validateEnvelopeSchema)}`);
  if (envelope.attempt > envelope.maxAttempts) throw new Error("task envelope attempt exceeds maxAttempts");
  if (envelope.attemptId !== v2AttemptId(envelope.taskId, envelope.attempt)) throw new Error("task envelope attemptId mismatch");
  if (envelope.planBaseRevision !== envelope.planBaseRevision.toLowerCase()) throw new Error("task envelope planBaseRevision must be lowercase");
  if (plan) {
    const record = task || v2Task(plan, envelope.taskId);
    const expected = createTaskEnvelopeV2({
      plan,
      task: record,
      issue: { number: envelope.issueNumber, url: envelope.issueUrl },
      baseRevision: envelope.baseRevision,
      attempt: envelope.attempt,
      validation,
    });
    if (!same(envelope, expected)) throw new Error("task envelope differs from the approved plan and task inputs");
  }
  const requirementIds = envelope.requirements.map((requirement) => requirement.id).sort();
  if (!same(requirementIds, [...envelope.requirementIds].sort())) throw new Error("task envelope requirements do not match requirementIds");
  return { envelope, digest: v2RuntimeDigest(envelope) };
}

const sensitivePattern = /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{8,}|(?:CODEX_API_KEY|IWF_TOKEN|GITHUB_TOKEN)\s*=)/i;
const localPathPattern = /(?:\/(?:home|Users|tmp)\/[^\s]+|[A-Za-z]:\\Users\\[^\s]+)/;

export function assertSafeRunnerText(value, label = "runner output") {
  const text = String(value || "");
  if (sensitivePattern.test(text)) throw new Error(`${label} contains a possible secret`);
  if (localPathPattern.test(text)) throw new Error(`${label} contains a local absolute path`);
  return text;
}

function exactEvidenceIds(actual, expected, label) {
  const actualIds = actual.map((entry) => entry.id);
  const expectedIds = expected.map((entry) => entry.id);
  if (new Set(actualIds).size !== actualIds.length) throw new Error(`${label} evidence IDs must be unique`);
  if (!same([...actualIds].sort(), [...expectedIds].sort())) throw new Error(`${label} evidence does not cover the task envelope exactly`);
}

export function validateAgentOutputV2(output, envelope) {
  if (!validateAgentOutputSchema(output)) throw new Error(`Codex output schema validation failed: ${errorsFor(validateAgentOutputSchema)}`);
  exactEvidenceIds(output.acceptance, envelope.acceptance, "acceptance");
  for (const evidence of output.acceptance) {
    const expected = envelope.acceptance.find((entry) => entry.id === evidence.id);
    if (evidence.requirementId !== expected.requirementId) throw new Error(`${evidence.id} requirementId mismatch`);
    for (const item of evidence.evidence) assertSafeRunnerText(item, `${evidence.id} evidence`);
  }
  assertSafeRunnerText(output.summary, "Codex summary");
  if (output.blockedReason) assertSafeRunnerText(output.blockedReason, "Codex blocked reason");
  if (output.status === "completed" && output.blockedReason !== null) throw new Error("completed Codex output cannot include blockedReason");
  if (output.status === "blocked" && !output.blockedReason) throw new Error("blocked Codex output requires blockedReason");
  return output;
}

function assertCompletionPaths(completion, envelope) {
  for (const file of completion.changedFiles) {
    for (const filePath of [file.path, file.previousPath].filter(Boolean)) {
      const scopeFailure = completion.status === "blocked" && completion.block?.kind === "scope";
      if (!scopeFailure && !isAllowedPath(filePath, envelope.allowedPaths)) throw new Error(`changed path is outside allowedPaths: ${filePath}`);
    }
    if (file.status === "renamed" && !file.previousPath) throw new Error(`renamed file ${file.path} requires previousPath`);
    if (file.status !== "renamed" && file.previousPath) throw new Error(`only renamed files may include previousPath`);
  }
}

export function validateTaskCompletionV2(completion, envelope) {
  if (!validateCompletionSchema(completion)) throw new Error(`task completion schema validation failed: ${errorsFor(validateCompletionSchema)}`);
  const identity = ["planId", "planDigest", "taskId", "attemptId", "baseRevision"];
  for (const key of identity) if (completion[key] !== envelope[key]) throw new Error(`task completion ${key} mismatch`);
  if (completion.envelopeDigest !== v2RuntimeDigest(envelope)) throw new Error("task completion envelopeDigest mismatch");
  if (!same(completion.runner, envelope.runner)) throw new Error("task completion runner metadata mismatch");
  exactEvidenceIds(completion.acceptance, envelope.acceptance, "acceptance");
  exactEvidenceIds(completion.verification, envelope.verification, "verification");
  for (const evidence of completion.acceptance) {
    const expected = envelope.acceptance.find((entry) => entry.id === evidence.id);
    if (evidence.requirementId !== expected.requirementId) throw new Error(`${evidence.id} requirementId mismatch`);
    for (const item of evidence.evidence) assertSafeRunnerText(item, `${evidence.id} evidence`);
  }
  for (const evidence of completion.verification) {
    const expected = envelope.verification.find((entry) => entry.id === evidence.id);
    if (!same(evidence.requirementIds, expected.requirementIds)) throw new Error(`${evidence.id} requirementIds mismatch`);
    if (evidence.command !== expected.command) throw new Error(`${evidence.id} command mismatch`);
    for (const item of evidence.evidence) assertSafeRunnerText(item, `${evidence.id} evidence`);
  }
  assertCompletionPaths(completion, envelope);
  if (completion.block) assertSafeRunnerText(completion.block.reason, "block reason");
  if (completion.block?.retryable && completion.block.kind !== "transient") {
    throw new Error("only a classified transient failure may be retryable");
  }
  if (completion.block?.retryable && envelope.attempt >= envelope.maxAttempts) {
    throw new Error("a failure cannot be retryable after maxAttempts is exhausted");
  }
  if (completion.status === "completed") {
    if (!completion.commitSha || !completion.changedFiles.length || completion.block !== null) throw new Error("completed task requires a commit, changed files, and no block");
    if (![...completion.acceptance, ...completion.verification].every((entry) => entry.status === "success")) {
      throw new Error("completed task requires successful acceptance and verification evidence");
    }
  } else if (completion.commitSha !== null || completion.block === null) {
    throw new Error("blocked task requires a block and cannot include a commit");
  }
  return { completion, digest: v2RuntimeDigest(completion) };
}

export { agentOutputSchema };
