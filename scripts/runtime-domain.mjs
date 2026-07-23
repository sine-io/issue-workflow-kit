import crypto from "node:crypto";

import { canonicalize, approvalDigest, validatePlan } from "./plan-validation.mjs";

export const EXECUTION_SCHEMA_VERSION = "task-execution/v1";
export const COMPLETION_SCHEMA_VERSION = "task-completion/v1";

export const TASK_STATUSES = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "in-review",
  "closed",
];

export const BLOCK_KINDS = [
  "dependency",
  "needs-input",
  "capability",
  "transient",
  "verification",
  "stale",
];

export const DEFAULT_EXECUTION = Object.freeze({
  commitPolicy: "required",
  allowedSideEffects: [],
  maxRuntimeSeconds: 7200,
  maxAttempts: 1,
  heartbeatIntervalSeconds: 300,
  requiredChecks: ["test"],
});

export const MARKERS = Object.freeze({
  execution: "issue-workflow-execution:v1",
  completion: "issue-workflow-completion:v1",
  attempt: "issue-workflow-attempt:v1",
  event: "issue-workflow-event:v1",
});

export function runtimeDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

export const envelopeDigest = runtimeDigest;
export const completionDigest = runtimeDigest;

export function attemptIdFor(taskId, attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  return `${taskId}-A${String(attempt).padStart(2, "0")}`;
}

export function acceptanceRunId(taskId, index) {
  if (!Number.isInteger(index) || index < 1) throw new Error("acceptance index must be a positive integer");
  return `${taskId}-AC${String(index).padStart(2, "0")}`;
}

export function verificationRunId(taskId, index) {
  if (!Number.isInteger(index) || index < 1) throw new Error("verification index must be a positive integer");
  return `${taskId}-V${String(index).padStart(2, "0")}`;
}

export function defaultBranch(taskId, attempt) {
  return `iwf/${taskId.toLowerCase()}-a${attempt}`;
}

function executionPolicy(record) {
  return {
    ...DEFAULT_EXECUTION,
    ...(record.execution || {}),
    allowedSideEffects: [...(record.execution?.allowedSideEffects || DEFAULT_EXECUTION.allowedSideEffects)],
    requiredChecks: [...(record.execution?.requiredChecks || DEFAULT_EXECUTION.requiredChecks)],
  };
}

function issueNumberOf(issue) {
  const number = Number(issue?.number ?? issue?.issueNumber);
  if (!Number.isInteger(number) || number < 1) throw new Error("issue number must be a positive integer");
  return number;
}

function issueUrlOf(issue) {
  const url = issue?.html_url || issue?.url || issue?.issueUrl;
  if (typeof url !== "string" || !url) throw new Error("issue URL is required");
  return url;
}

function runDefinitions(taskId, record) {
  return {
    acceptance: record.acceptanceCriteria.map((description, index) => ({
      id: acceptanceRunId(taskId, index + 1),
      description,
    })),
    verification: record.verificationSteps.map((description, index) => ({
      id: verificationRunId(taskId, index + 1),
      description,
    })),
  };
}

export function createExecutionEnvelope({ plan, record, issue, attempt = 1, agent, branch }) {
  if (!plan || !record) throw new Error("plan and task record are required");
  validatePlan(plan, { requireApproval: true });
  if (record.kind && record.kind !== "task") throw new Error("execution envelopes can only be created for tasks");
  if (!agent || typeof agent !== "string") throw new Error("agent is required");
  const policy = executionPolicy(record);
  if (record.execution?.agent && record.execution.agent !== agent) {
    throw new Error(`agent ${agent} does not match the approved agent ${record.execution.agent}`);
  }
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > policy.maxAttempts) {
    throw new Error(`attempt must be between 1 and ${policy.maxAttempts}`);
  }
  const taskId = record.id;
  const envelope = {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    planId: plan.plan.id,
    taskId,
    issueNumber: issueNumberOf(issue),
    issueUrl: issueUrlOf(issue),
    workflowRevision: plan.workflow.revision,
    approvalDigest: approvalDigest(plan),
    attemptId: attemptIdFor(taskId, attempt),
    attempt,
    agent,
    branch: branch || defaultBranch(taskId, attempt),
    allowedPaths: [...record.allowedPaths],
    commitPolicy: policy.commitPolicy,
    allowedSideEffects: [...policy.allowedSideEffects],
    maxRuntimeSeconds: policy.maxRuntimeSeconds,
    maxAttempts: policy.maxAttempts,
    heartbeatIntervalSeconds: policy.heartbeatIntervalSeconds,
    requiredChecks: [...policy.requiredChecks],
    ...runDefinitions(taskId, record),
  };
  return envelope;
}

export function createCompletionResult({ envelope, result, acceptance, verification, artifacts = [], note }) {
  if (!envelope?.attemptId) throw new Error("execution envelope is required");
  return {
    schemaVersion: COMPLETION_SCHEMA_VERSION,
    planId: envelope.planId,
    taskId: envelope.taskId,
    issueNumber: envelope.issueNumber,
    attemptId: envelope.attemptId,
    envelopeDigest: envelopeDigest(envelope),
    result,
    acceptance: acceptance ? structuredClone(acceptance) : [],
    verification: verification ? structuredClone(verification) : [],
    artifacts: structuredClone(artifacts),
    ...(note ? { note } : {}),
  };
}

export function marker(kind, payload) {
  if (!MARKERS[kind]) throw new Error(`unknown runtime marker kind ${kind}`);
  return `<!-- ${MARKERS[kind]} ${JSON.stringify(canonicalize(payload))} -->`;
}

export function parseMarker(body, kind) {
  if (!MARKERS[kind]) throw new Error(`unknown runtime marker kind ${kind}`);
  const prefix = `<!-- ${MARKERS[kind]} `;
  const source = String(body || "");
  const start = source.indexOf(prefix);
  if (start === -1) return null;
  const end = source.indexOf(" -->", start + prefix.length);
  if (end === -1) throw new Error(`incomplete ${kind} marker`);
  const raw = source.slice(start + prefix.length, end);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid ${kind} marker: ${error.message}`);
  }
}

export function isAllowedPath(filePath, allowedPaths) {
  if (typeof filePath !== "string" || !filePath || filePath.startsWith("/") || filePath.includes("\\")) return false;
  const parts = filePath.split("/");
  if (parts.includes("..") || parts.includes("")) return false;
  return (allowedPaths || []).some((allowed) => {
    if (allowed.endsWith("/**")) return filePath.startsWith(`${allowed.slice(0, -3)}/`);
    return filePath === allowed;
  });
}

export function allPathsAllowed(paths, allowedPaths) {
  return (paths || []).every((filePath) => isAllowedPath(filePath, allowedPaths));
}

export function canTransitionTaskStatus(from, to) {
  const transitions = {
    backlog: new Set(["ready"]),
    ready: new Set(["in-progress"]),
    "in-progress": new Set(["blocked", "in-review"]),
    blocked: new Set(["in-progress"]),
    "in-review": new Set(["closed"]),
    closed: new Set(),
  };
  return Boolean(transitions[from]?.has(to));
}

export function assertTaskStatusTransition(from, to) {
  if (!canTransitionTaskStatus(from, to)) throw new Error(`invalid task status transition ${from} -> ${to}`);
  return to;
}
