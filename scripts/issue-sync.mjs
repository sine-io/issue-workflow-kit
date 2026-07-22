import { mergeManagedBody, renderManagedBody } from "./issue-body.mjs";
import {
  flattenPlan,
  labelsForExisting,
  labelsForNew,
  parseIdentity,
  reverseDependencies,
} from "./plan-domain.mjs";
import { validatePlan } from "./plan-validation.mjs";

export const WORKFLOW_LABELS = [
  { name: "type:epic", color: "3E4B9E", description: "Parent issue for an approved workflow plan" },
  { name: "type:task", color: "1D76DB", description: "Atomic issue delivered by one pull request" },
  { name: "priority:P0", color: "B60205", description: "Highest priority" },
  { name: "priority:P1", color: "D93F0B", description: "Important delivery work" },
  { name: "priority:P2", color: "FBCA04", description: "Polish and maintenance" },
  { name: "status:backlog", color: "6E7781", description: "Blocked or not ready to start" },
  { name: "status:ready", color: "0E8A16", description: "Dependencies are closed and work may start" },
  { name: "status:in-progress", color: "FBCA04", description: "Implementation is active" },
  { name: "status:in-review", color: "8250DF", description: "Pull request is under automated review" },
];

function labelNames(issue) {
  return (issue.labels || []).map((label) => typeof label === "string" ? label : label.name);
}

function labelsForExistingIssue(record, currentLabels) {
  const desired = labelsForExisting(record, currentLabels);
  if (currentLabels.some((label) => label.startsWith("status:"))) return desired;
  return desired.filter((label) => !label.startsWith("status:"));
}

function sameLabels(left, right) {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function sameLabelDefinition(current, desired) {
  return current.name === desired.name
    && String(current.color || "").toUpperCase() === desired.color
    && String(current.description || "") === desired.description;
}

function issueRef(issue) {
  return {
    number: issue.number,
    nodeId: issue.node_id || issue.nodeId,
    url: issue.html_url || issue.url,
  };
}

function nodeIdOf(ref) {
  return ref?.nodeId || ref?.node_id || ref?.id;
}

function identitiesForPlan(issues, planId) {
  const byTaskId = new Map();
  for (const issue of issues) {
    const body = String(issue.body || "");
    const identity = parseIdentity(body);
    if (!identity && body.includes("<!-- issue-workflow:")) {
      throw new Error(`Issue #${issue.number} contains an unreadable issue workflow identity marker`);
    }
    if (!identity || identity.planId !== planId) continue;
    if (byTaskId.has(identity.taskId)) {
      throw new Error(`multiple Issues use identity ${planId}/${identity.taskId}`);
    }
    byTaskId.set(identity.taskId, issue);
  }
  return byTaskId;
}

async function syncLabels(adapter, repository, preview, operations) {
  const current = new Map((await adapter.listLabels(repository)).map((label) => [label.name, label]));
  for (const desired of WORKFLOW_LABELS) {
    const existing = current.get(desired.name);
    if (!existing) {
      operations.push({ resource: "label", action: "create", name: desired.name });
      if (!preview) await adapter.createLabel(repository, desired);
    } else if (!sameLabelDefinition(existing, desired)) {
      operations.push({ resource: "label", action: "update", name: desired.name });
      if (!preview) await adapter.updateLabel(repository, existing.name, desired);
    }
  }
}

export async function syncIssues({ plan, repository, adapter, preview = false }) {
  validatePlan(plan, { requireApproval: true });
  const records = flattenPlan(plan, { validate: false });
  const reverse = reverseDependencies(records);
  const operations = [];

  const existingIssues = await adapter.listIssues(repository);
  const byTaskId = identitiesForPlan(existingIssues, plan.plan.id);
  await syncLabels(adapter, repository, preview, operations);

  const refs = new Map();
  for (const record of records) {
    const existing = byTaskId.get(record.id);
    if (existing) refs.set(record.id, issueRef(existing));
  }

  const outcomes = new Map();
  for (const record of records) {
    let issue = byTaskId.get(record.id);
    if (!issue) {
      operations.push({ resource: "issue", action: "create", id: record.id });
      if (preview) {
        outcomes.set(record.id, { id: record.id, number: null, url: null, created: true, updated: false });
        continue;
      }
      const managedBody = renderManagedBody(plan, record, refs, reverse);
      issue = await adapter.createIssue(repository, {
        title: `[${record.id}] ${record.title}`,
        body: mergeManagedBody("", managedBody),
        labels: labelsForNew(record),
      });
      byTaskId.set(record.id, issue);
      refs.set(record.id, issueRef(issue));
      outcomes.set(record.id, {
        id: record.id,
        number: issue.number,
        url: issue.html_url || issue.url,
        created: true,
        updated: false,
      });
    }
  }

  for (const record of records) {
    const issue = byTaskId.get(record.id);
    if (!issue) continue;
    const desiredBody = mergeManagedBody(issue.body, renderManagedBody(plan, record, refs, reverse));
    const desiredLabels = labelsForExistingIssue(record, labelNames(issue));
    const bodyChanged = String(issue.body || "") !== desiredBody;
    const labelsChanged = !sameLabels(labelNames(issue), desiredLabels);
    if (bodyChanged || labelsChanged) {
      operations.push({
        resource: "issue",
        action: "update",
        id: record.id,
        number: issue.number,
        fields: [bodyChanged ? "body" : null, labelsChanged ? "labels" : null].filter(Boolean),
      });
      if (!preview) {
        const updated = await adapter.updateIssue(repository, issue.number, {
          body: desiredBody,
          labels: desiredLabels,
        });
        byTaskId.set(record.id, updated);
      }
    }
    const previous = outcomes.get(record.id);
    outcomes.set(record.id, {
      id: record.id,
      number: issue.number,
      url: issue.html_url || issue.url,
      created: previous?.created || false,
      updated: bodyChanged || labelsChanged,
    });
  }

  return {
    repository,
    planId: plan.plan.id,
    preview,
    operations,
    issues: records.map((record) => outcomes.get(record.id)),
    refs,
  };
}

function refsForPlanIssues(issues, planId) {
  const refs = new Map();
  for (const issue of issues) {
    const identity = parseIdentity(issue.body || "");
    if (!identity || identity.planId !== planId) continue;
    if (refs.has(identity.taskId)) throw new Error(`multiple Issues use identity ${planId}/${identity.taskId}`);
    refs.set(identity.taskId, issueRef(issue));
  }
  return refs;
}

async function ensureRelationshipRefs(plan, repository, adapter, refs) {
  const owned = refsForPlanIssues(await adapter.listIssues(repository), plan.plan.id);
  for (const [id, ref] of refs || []) owned.set(id, ref);
  const resolved = new Map();
  for (const record of flattenPlan(plan, { validate: false })) {
    const ref = owned.get(record.id);
    if (!ref || !nodeIdOf(ref)) throw new Error(`Issue reference for ${record.id} is missing a GraphQL node ID`);
    resolved.set(record.id, ref);
  }
  return { resolved, owned };
}

export async function syncRelationships({ plan, repository, adapter, refs, preview = false }) {
  validatePlan(plan, { requireApproval: true });
  const records = flattenPlan(plan, { validate: false });
  const { resolved, owned } = await ensureRelationshipRefs(plan, repository, adapter, refs);
  const planByNodeId = new Map([...owned.entries()].map(([id, ref]) => [nodeIdOf(ref), id]));
  const operations = [];

  const tasksByParent = new Map();
  for (const record of records.filter((item) => item.kind === "task")) {
    if (!tasksByParent.has(record.parentId)) tasksByParent.set(record.parentId, new Set());
    tasksByParent.get(record.parentId).add(record.id);
  }

  for (const [parentId, parentRef] of owned) {
    const parentNodeId = nodeIdOf(parentRef);
    const current = await adapter.listSubIssues(parentNodeId);
    const currentByNode = new Map(current.map((ref) => [nodeIdOf(ref), ref]));
    const desiredIds = tasksByParent.get(parentId) || new Set();
    for (const [childNodeId] of currentByNode) {
      const childId = planByNodeId.get(childNodeId);
      if (childId && !desiredIds.has(childId)) {
        operations.push({ action: "remove-sub-issue", parentId, childId });
        if (!preview) await adapter.removeSubIssue(parentNodeId, childNodeId);
      }
    }
    for (const childId of desiredIds) {
      const childNodeId = nodeIdOf(resolved.get(childId));
      if (!currentByNode.has(childNodeId)) {
        operations.push({ action: "add-sub-issue", parentId, childId });
        if (!preview) await adapter.addSubIssue(parentNodeId, childNodeId);
      }
    }
  }

  const recordsById = new Map(records.map((record) => [record.id, record]));
  for (const [issueId, issueRef] of owned) {
    const task = recordsById.get(issueId);
    const issueNodeId = nodeIdOf(issueRef);
    const current = await adapter.listBlockedBy(issueNodeId);
    const currentByNode = new Map(current.map((ref) => [nodeIdOf(ref), ref]));
    const desiredIds = new Set(task?.kind === "task" ? task.dependsOn : []);
    for (const [blockingNodeId] of currentByNode) {
      const blockingId = planByNodeId.get(blockingNodeId);
      if (blockingId && !desiredIds.has(blockingId)) {
        operations.push({ action: "remove-dependency", issueId, blockingId });
        if (!preview) await adapter.removeBlockedBy(issueNodeId, blockingNodeId);
      }
    }
    for (const blockingId of desiredIds) {
      const blockingNodeId = nodeIdOf(resolved.get(blockingId));
      if (!currentByNode.has(blockingNodeId)) {
        operations.push({ action: "add-dependency", issueId, blockingId });
        if (!preview) await adapter.addBlockedBy(issueNodeId, blockingNodeId);
      }
    }
  }

  return { repository, planId: plan.plan.id, preview, operations, refs: resolved };
}
