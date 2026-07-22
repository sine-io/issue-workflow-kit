import { validatePlan } from "./plan-validation.mjs";

export const STATUS_LABELS = [
  "status:backlog",
  "status:ready",
  "status:in-progress",
  "status:in-review",
];

export function flattenPlan(plan, { validate = true } = {}) {
  if (validate) validatePlan(plan);
  const flattened = [];
  for (const epic of plan.epics) {
    flattened.push({
      ...structuredClone(epic),
      kind: "epic",
      parentId: null,
      epicId: epic.id,
    });
    for (const task of epic.tasks) {
      flattened.push({
        ...structuredClone(task),
        kind: "task",
        parentId: epic.id,
        epicId: epic.id,
      });
    }
  }
  return flattened;
}

export function recordsById(records) {
  return new Map(records.map((record) => [record.id, record]));
}

export function reverseDependencies(records) {
  const reverse = new Map(records.map((record) => [record.id, []]));
  for (const record of records.filter((item) => item.kind === "task")) {
    for (const dependency of record.dependsOn) {
      if (!reverse.has(dependency)) reverse.set(dependency, []);
      reverse.get(dependency).push(record.id);
    }
  }
  return reverse;
}

export function deriveInitialStatus(record) {
  return record.kind === "task" && record.dependsOn.length === 0
    ? "status:ready"
    : "status:backlog";
}

export function identityFor(plan, record) {
  return {
    planId: plan.plan.id,
    taskId: record.id,
    workflowRevision: plan.workflow.revision,
  };
}

export function identityMarker(plan, record) {
  return `<!-- issue-workflow:${JSON.stringify(identityFor(plan, record))} -->`;
}

const identityPattern = /<!-- issue-workflow:(\{[^\n]+\}) -->/;

export function parseIdentity(body) {
  const match = String(body || "").match(identityPattern);
  if (!match) return null;
  let identity;
  try {
    identity = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`invalid issue workflow identity marker: ${error.message}`);
  }
  if (!identity || typeof identity !== "object"
    || typeof identity.planId !== "string"
    || typeof identity.taskId !== "string"
    || typeof identity.workflowRevision !== "string") {
    throw new Error("issue workflow identity marker must contain planId, taskId, and workflowRevision strings");
  }
  return identity;
}

function managedLabelFamily(label) {
  return /^(?:type|priority|status):/.test(label);
}

export function labelsForNew(record) {
  return [`type:${record.kind}`, `priority:${record.priority}`, deriveInitialStatus(record)];
}

export function labelsForExisting(record, currentLabels) {
  const preserved = (currentLabels || []).filter((label) => !managedLabelFamily(label));
  const currentStatus = (currentLabels || []).filter((label) => label.startsWith("status:"));
  return [...new Set([
    ...preserved,
    `type:${record.kind}`,
    `priority:${record.priority}`,
    ...(currentStatus.length ? currentStatus : [deriveInitialStatus(record)]),
  ])];
}
