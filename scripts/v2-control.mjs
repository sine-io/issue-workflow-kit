import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { GitHubAdapter } from "./github-adapter.mjs";
import { WORKFLOW_LABELS } from "./issue-sync.mjs";
import { parseIdentity } from "./plan-domain.mjs";
import { isAllowedPath } from "./runtime-domain.mjs";
import { canonicalizeV2, flattenV2Plan, validateV2Plan, v2PlanDigest } from "./v2-plan.mjs";
import {
  assertSafeRunnerText,
  createTaskEnvelopeV2,
  validateTaskCompletionV2,
  validateTaskEnvelopeV2,
  v2RuntimeDigest,
} from "./v2-runner-protocol.mjs";
import { validateTaskReview } from "./v2-review.mjs";

export const V2_ISSUE_MARKER = "iwf-v2-issue";
export const V2_EVENT_MARKER = "iwf-v2-event";
const automationActors = new WeakMap();

function nowIso(clock) {
  return (clock ? clock() : new Date()).toISOString();
}

function marker(prefix, value) {
  const encoded = JSON.stringify(canonicalizeV2(value)).replaceAll("--", "\\u002d\\u002d");
  return `<!-- ${prefix} ${encoded} -->`;
}

function parseMarker(source, prefix) {
  const input = String(source || "");
  const start = input.indexOf(`<!-- ${prefix} `);
  if (start === -1) return null;
  const end = input.indexOf(" -->", start);
  if (end === -1) throw new Error(`incomplete ${prefix} marker`);
  try {
    return JSON.parse(input.slice(start + prefix.length + 5, end));
  } catch (error) {
    throw new Error(`invalid ${prefix} marker: ${error.message}`);
  }
}

export function parseV2IssueIdentity(body) {
  return parseMarker(body, V2_ISSUE_MARKER);
}

export function parseV2Event(body) {
  return parseMarker(body, V2_EVENT_MARKER);
}

function eventId(event) {
  if (event.eventId) return event.eventId;
  return `${event.type}:${event.planId}:${event.taskId}:${event.attemptId || ""}:${event.prNumber || ""}:${event.reviewKind || event.kind || ""}`;
}

function eventBody(event) {
  const summary = {
    claim: "Task claimed",
    heartbeat: "Task heartbeat",
    superseded: "Task claim superseded",
    submit: "Task submitted for review",
    block: "Task blocked",
    review: `${event.reviewKind || "task"} review recorded`,
    complete: "Task completed after merge",
  }[event.type] || `IWF event: ${event.type}`;
  return `${summary}\n\n${marker(V2_EVENT_MARKER, { ...event, eventId: eventId(event) })}`;
}

function commentSort(left, right) {
  const leftAt = Date.parse(left.value.at || left.comment.created_at || "") || 0;
  const rightAt = Date.parse(right.value.at || right.comment.created_at || "") || 0;
  if (leftAt !== rightAt) return leftAt - rightAt;
  return Number(left.comment.id || 0) - Number(right.comment.id || 0);
}

async function automationLogin(adapter) {
  if (!automationActors.has(adapter)) {
    if (typeof adapter.getAuthenticatedUser !== "function") throw new Error("GitHub adapter cannot verify the automation identity");
    automationActors.set(adapter, Promise.resolve(adapter.getAuthenticatedUser()).then((user) => {
      if (!user?.login) throw new Error("GitHub did not return the automation identity");
      return user.login;
    }));
  }
  return automationActors.get(adapter);
}

function createdBy(issueOrComment, login) {
  return String(issueOrComment?.user?.login || "").toLowerCase() === String(login).toLowerCase();
}

async function issueComments(adapter, repository, issueNumber) {
  const login = await automationLogin(adapter);
  const comments = await (adapter.listIssueComments ? adapter.listIssueComments(repository, issueNumber) : adapter.listComments(repository, issueNumber));
  return comments.filter((comment) => createdBy(comment, login)).map((comment) => {
    const value = parseV2Event(comment.body);
    return value ? { comment, value } : null;
  }).filter(Boolean);
}

async function appendEvent({ adapter, repository, issueNumber, event }) {
  const existing = await issueComments(adapter, repository, issueNumber);
  const id = eventId(event);
  const duplicate = existing.find((entry) => entry.value.eventId === id);
  if (duplicate) return { created: false, comment: duplicate.comment, value: duplicate.value };
  const value = { ...event, eventId: id };
  const comment = await (adapter.createIssueComment
    ? adapter.createIssueComment(repository, issueNumber, eventBody(value))
    : adapter.createComment(repository, issueNumber, eventBody(value)));
  return { created: true, comment, value };
}

function labelsOf(issue) {
  return (issue.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean);
}

async function setStatus({ adapter, repository, issue, status }) {
  const current = labelsOf(issue);
  const next = [...new Set([...current.filter((label) => !label.startsWith("status:")), `status:${status}`])].sort();
  if (current.slice().sort().join("\n") === next.join("\n")) return false;
  const updated = await adapter.updateIssue(repository, issue.number, { labels: next });
  Object.assign(issue, updated);
  return true;
}

function renderIssueBody(plan, record, { parentNumber } = {}) {
  const identity = {
    version: 2,
    planId: plan.plan.id,
    planDigest: v2PlanDigest(plan),
    taskId: record.id,
    kind: record.kind,
    workflowRevision: plan.workflow.revision,
  };
  const requirements = record.requirementIds.map((id) => {
    const requirement = plan.requirements.find((candidate) => candidate.id === id);
    return `### ${id}: ${requirement?.title || "Unknown requirement"}\n${requirement?.behavior || ""}`;
  }).join("\n\n");
  const acceptance = record.acceptanceCriteria.map((criterion) => `- [ ] \`${criterion.id}\` [${criterion.requirementId}] ${criterion.statement}`).join("\n");
  const verification = record.verificationSteps.map((step) => `- [ ] \`${step.id}\` [${step.requirementIds.join(", ")}] \`${step.command}\` -> ${step.expected}`).join("\n");
  const relation = parentNumber ? `\nParent Epic: #${parentNumber}\n` : "";
  return `${marker(V2_ISSUE_MARKER, identity)}\n\n## ${record.kind === "epic" ? "Issue Workflow Plan" : "Issue Workflow Task"}\n\n**${record.title}**\n\n${record.goal}\n\n### Expected behavior\n${record.expectedBehavior}\n${relation}\n### Requirement trace\n${requirements}\n\n### Scope\n${record.scope.map((item) => `- ${item}`).join("\n")}\n\n### Allowed paths\n${record.allowedPaths.map((item) => `- \`${item}\``).join("\n")}\n\n### Out of scope\n${record.outOfScope.map((item) => `- ${item}`).join("\n")}\n\n### Acceptance evidence\n${acceptance}\n\n### Verification\n${verification}\n\n### Stop conditions\nStop on scope, digest, base revision, requirement, authentication, CI, or review disagreement. Do not broaden this task.\n\n<!-- iwf-v2-managed:end -->\n`;
}

function mergeBody(current, generated) {
  const source = String(current || "");
  const start = source.indexOf(`<!-- ${V2_ISSUE_MARKER} `);
  if (start === -1) return generated + (source ? `\n\n${source}` : "");
  const endMarker = source.indexOf("<!-- iwf-v2-managed:end -->", start);
  if (endMarker === -1) throw new Error("managed v2 Issue block is incomplete");
  const end = endMarker + "<!-- iwf-v2-managed:end -->".length;
  const prefix = source.slice(0, start).replace(/\s+$/, "");
  const suffix = source.slice(end).replace(/^\n+/, "");
  return `${prefix ? `${prefix}\n\n` : ""}${generated}${suffix ? `\n${suffix}` : ""}`;
}

function desiredLabels(record, initialStatus) {
  return [`type:${record.kind === "epic" ? "epic" : "task"}`, `priority:${record.priority}`, `status:${initialStatus}`];
}

function issueIdentityMap(issues, planId, login) {
  const map = new Map();
  for (const issue of issues) {
    if (!createdBy(issue, login)) continue;
    const identity = parseV2IssueIdentity(issue.body);
    if (!identity || identity.planId !== planId) continue;
    if (map.has(identity.taskId)) throw new Error(`multiple v2 Issues use identity ${planId}/${identity.taskId}`);
    map.set(identity.taskId, issue);
  }
  return map;
}

async function syncLabels(adapter, repository) {
  const current = new Map((await adapter.listLabels(repository)).map((label) => [label.name, label]));
  for (const desired of WORKFLOW_LABELS) {
    if (!current.has(desired.name)) await adapter.createLabel(repository, desired);
  }
}

export async function verifyPlanningApproval({ plan, planPath, repository, adapter, defaultBranch }) {
  const normalizedPlan = path.resolve(planPath).split(path.sep).join("/");
  const repositoryMarker = "/.github/issue-plans/";
  const markerIndex = normalizedPlan.lastIndexOf(repositoryMarker);
  const relativePlan = markerIndex === -1
    ? path.relative(process.cwd(), path.resolve(planPath)).split(path.sep).join("/")
    : normalizedPlan.slice(markerIndex + 1);
  const contract = plan.contract.path;
  const pulls = await adapter.listPullRequests(repository, { state: "closed", base: defaultBranch });
  const expectedMarker = marker("iwf-plan-pr:v2", { digest: v2PlanDigest(plan), planId: plan.plan.id });
  const candidates = pulls.filter((pull) => pull.merged_at && String(pull.body || "").includes(expectedMarker));
  if (candidates.length !== 1) throw new Error(`expected exactly one merged planning PR for ${plan.plan.id}`);
  const pull = candidates[0];
  if (pull.base?.ref && pull.base.ref !== defaultBranch) throw new Error("planning PR base branch mismatch");
  const files = await adapter.listPullRequestFiles(repository, pull.number);
  const names = files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
  const expectedFiles = new Set([relativePlan, path.posix.join(path.posix.dirname(relativePlan), contract)]);
  if (names.length !== expectedFiles.size || names.some((name) => !expectedFiles.has(name))) throw new Error("planning PR changed files outside plan and behavior contract");
  return { pullRequest: pull, digest: v2PlanDigest(plan) };
}

export async function syncV2Issues({ plan, planPath, repository, adapter, defaultBranch }) {
  const validation = validateV2Plan(plan, { sourcePath: planPath, requireApproval: true });
  const repositoryInfo = await adapter.getRepository(repository);
  const branch = defaultBranch || repositoryInfo.default_branch;
  await verifyPlanningApproval({ plan, planPath, repository, adapter, defaultBranch: branch });
  const login = await automationLogin(adapter);
  await syncLabels(adapter, repository);
  const records = flattenV2Plan(plan);
  const existing = issueIdentityMap(await adapter.listIssues(repository), plan.plan.id, login);
  const refs = new Map();
  const operations = [];
  const taskRecords = records.filter((record) => record.kind === "task");
  const initialStatus = new Map(records.map((record) => [record.id, record.kind === "epic" ? "backlog" : record.id === taskRecords[0].id ? "ready" : "backlog"]));
  for (const record of records) {
    let issue = existing.get(record.id);
    let created = false;
    if (!issue) {
      const parent = record.kind === "task" ? existing.get(record.parentId) : null;
      const createdIssue = await adapter.createIssue(repository, {
        title: `[${record.id}] ${record.title}`,
        body: renderIssueBody(plan, record, { parentNumber: parent?.number }),
        labels: desiredLabels(record, initialStatus.get(record.id)),
      });
      issue = createdIssue;
      created = true;
      existing.set(record.id, issue);
      operations.push({ action: "create", id: record.id, number: issue.number });
    }
    refs.set(record.id, { number: issue.number, nodeId: issue.node_id || issue.nodeId, url: issue.html_url || issue.url });
    const generated = renderIssueBody(plan, record, { parentNumber: record.kind === "task" ? existing.get(record.parentId)?.number : undefined });
    const body = mergeBody(issue.body, generated);
    if (body !== String(issue.body || "")) {
      issue = await adapter.updateIssue(repository, issue.number, { body });
      existing.set(record.id, issue);
      operations.push({ action: "update-body", id: record.id, number: issue.number });
    }
    if (created && !labelsOf(issue).some((label) => label === `status:${initialStatus.get(record.id)}`) && issue.state !== "closed") {
      await setStatus({ adapter, repository, issue, status: initialStatus.get(record.id) });
      operations.push({ action: "set-status", id: record.id, status: initialStatus.get(record.id) });
    }
  }
  for (const record of records.filter((item) => item.kind === "task")) {
    const parent = refs.get(record.parentId);
    const child = refs.get(record.id);
    if (parent?.nodeId && child?.nodeId) {
      const current = await adapter.listSubIssues(parent.nodeId);
      if (!current.some((item) => (item.node_id || item.nodeId || item.id) === child.nodeId)) await adapter.addSubIssue(parent.nodeId, child.nodeId);
    }
    for (const dependency of record.dependsOn) {
      const blocking = refs.get(dependency);
      if (child?.nodeId && blocking?.nodeId) {
        const current = await adapter.listBlockedBy(child.nodeId);
        if (!current.some((item) => (item.node_id || item.nodeId || item.id) === blocking.nodeId)) await adapter.addBlockedBy(child.nodeId, blocking.nodeId);
      }
    }
  }
  return { planId: plan.plan.id, digest: validation.digest, repository, issues: [...existing.values()], refs, operations };
}

function eventsFor(comments, planId, taskId) {
  return comments.filter((entry) => entry.value.planId === planId && entry.value.taskId === taskId).sort(commentSort);
}

function latest(events, types) {
  return [...events].filter((entry) => types.includes(entry.value.type)).sort(commentSort).at(-1) || null;
}

function managedStatus(issue) {
  if (issue.state === "closed") return "closed";
  return labelsOf(issue).find((label) => label.startsWith("status:"))?.slice("status:".length) || "backlog";
}

function dependenciesCompleted(record, states) {
  return record.dependsOn.every((dependency) => states.get(dependency)?.status === "closed");
}

function activeState(state) {
  return ["in-progress", "in-review"].includes(state);
}

async function taskContexts({ plan, repository, adapter, issues }) {
  const records = flattenV2Plan(plan);
  const contexts = new Map();
  for (const record of records.filter((item) => item.kind === "task")) {
    const issue = issues.get(record.id);
    if (!issue) throw new Error(`managed Issue for ${record.id} is missing`);
    const comments = await issueComments(adapter, repository, issue.number);
    contexts.set(record.id, { record, issue, comments, events: eventsFor(comments, plan.plan.id, record.id), status: managedStatus(issue) });
  }
  return { records, contexts };
}

export async function claimNextTask({ plan, planPath, repository, adapter, issueRefs, baseRevision, agent, attemptClock = () => new Date() }) {
  validateV2Plan(plan, { sourcePath: planPath, requireApproval: true });
  if (!agent) throw new Error("claiming agent is required");
  const login = await automationLogin(adapter);
  const issues = new Map((await adapter.listIssues(repository)).map((issue) => {
    const identity = parseV2IssueIdentity(issue.body);
    return [createdBy(issue, login) && identity?.planId === plan.plan.id && identity.planDigest === v2PlanDigest(plan) ? identity.taskId : null, issue];
  }).filter(([id]) => id));
  const { records, contexts } = await taskContexts({ plan, repository, adapter, issues });
  const states = new Map([...contexts.entries()].map(([id, context]) => [id, { status: context.status, events: context.events }]));
  for (const context of contexts.values()) {
    const inProgress = latest(context.events, ["claim"]);
    const submitted = latest(context.events, ["submit"]);
    const blocked = latest(context.events, ["block"]);
    const completed = latest(context.events, ["complete"]);
    const activeComplete = completed && (!blocked || commentSort(blocked, completed) < 0);
    const activeSubmit = submitted && (!blocked || commentSort(blocked, submitted) < 0);
    if (activeComplete) states.set(context.record.id, { status: "closed", events: context.events });
    else if (activeSubmit) states.set(context.record.id, { status: "in-review", events: context.events });
    else if (inProgress && (!blocked || commentSort(blocked, inProgress) < 0)) states.set(context.record.id, { status: "in-progress", events: context.events });
    else if (blocked || context.issue.state === "closed") states.set(context.record.id, { status: "blocked", events: context.events });
  }
  const active = [...states.values()].find((state) => activeState(state.status));
  if (active) return { status: "stopped", reason: `workflow has an active ${active.status} task` };
  const next = records.filter((record) => record.kind === "task").find((record) => {
    const state = states.get(record.id);
    return state?.status !== "closed" && dependenciesCompleted(record, states);
  });
  if (!next) return { status: "complete", reason: "all tasks are closed" };
  const context = contexts.get(next.id);
  const blocked = latest(context.events, ["block"]);
  const previousAttempt = blocked?.value.attempt || 0;
  if (blocked && (!blocked.value.retryable || previousAttempt >= next.execution.maxAttempts)) {
    return { status: "stopped", reason: `task ${next.id} is blocked: ${blocked.value.reason}` };
  }
  const attempt = previousAttempt + 1;
  const branchSha = baseRevision || (await adapter.getBranch(repository, plan.repository.defaultBranch)).commit?.sha;
  if (!branchSha) throw new Error("current default branch SHA is required to claim a task");
  const issue = context.issue;
  const validation = validateV2Plan(plan, { sourcePath: planPath, requireApproval: true });
  const envelope = createTaskEnvelopeV2({ plan, task: next, issue, baseRevision: branchSha.toLowerCase(), attempt, validation });
  validateTaskEnvelopeV2(envelope, { plan: undefined });
  const at = nowIso(attemptClock);
  const claimId = crypto.randomUUID();
  await appendEvent({ adapter, repository, issueNumber: issue.number, event: {
    type: "claim", planId: plan.plan.id, planDigest: validation.digest, taskId: next.id,
    attemptId: envelope.attemptId, attempt, at, agent, claimId, baseRevision: envelope.baseRevision,
    envelope, envelopeDigest: v2RuntimeDigest(envelope),
  } });
  const reread = eventsFor(await issueComments(adapter, repository, issue.number), plan.plan.id, next.id)
    .filter((entry) => entry.value.type === "claim" && entry.value.attemptId === envelope.attemptId);
  const winner = [...reread].sort(commentSort)[0];
  if (!winner || winner.value.claimId !== claimId) {
    await appendEvent({ adapter, repository, issueNumber: issue.number, event: {
      type: "superseded", planId: plan.plan.id, planDigest: validation.digest, taskId: next.id,
      attemptId: envelope.attemptId, attempt, at: nowIso(attemptClock), claimId, winner: winner?.value.claimId || null,
    } });
    return { status: "superseded", taskId: next.id, attemptId: envelope.attemptId };
  }
  await setStatus({ adapter, repository, issue, status: "in-progress" });
  return { status: "claimed", taskId: next.id, issueNumber: issue.number, attemptId: envelope.attemptId, envelope, envelopeDigest: v2RuntimeDigest(envelope) };
}

function completionIssueEvent(completion, envelope, at) {
  return {
    type: completion.status === "completed" ? "submit" : "block",
    planId: envelope.planId,
    planDigest: envelope.planDigest,
    taskId: envelope.taskId,
    attemptId: envelope.attemptId,
    attempt: envelope.attempt,
    at,
    envelopeDigest: v2RuntimeDigest(envelope),
    completionDigest: v2RuntimeDigest(completion),
    envelope,
    completion,
    ...(completion.block || {}),
  };
}

function prNumber(value) {
  if (Number.isInteger(value) && value > 0) return value;
  const match = String(value || "").match(/\/pull\/(\d+)(?:[/?#]|$)/);
  if (!match) throw new Error("pull request number or URL is required");
  return Number(match[1]);
}

function authoritativeChangedFiles(files) {
  const status = { added: "added", modified: "modified", removed: "deleted", renamed: "renamed" };
  return files.map((file) => {
    const normalized = status[file.status];
    if (!normalized) throw new Error(`unsupported GitHub file status ${file.status || "<missing>"}`);
    const record = { path: file.filename, status: normalized };
    if (normalized === "renamed") {
      if (!file.previous_filename) throw new Error(`renamed file ${file.filename} has no previous path`);
      record.previousPath = file.previous_filename;
    }
    return record;
  }).sort((left, right) => left.path.localeCompare(right.path));
}

async function assertSingleManagedClosingIssue({ adapter, repository, pullRequest, currentIssue }) {
  const pullNodeId = pullRequest.node_id || pullRequest.nodeId;
  if (!pullNodeId) throw new Error("task pull request is missing a GraphQL node ID");
  const closing = await adapter.listPullRequestClosingIssues(pullNodeId);
  const current = closing.filter((item) => Number(item.number) === Number(currentIssue.number)
    && (!item.repository?.nameWithOwner || item.repository.nameWithOwner.toLowerCase() === repository.toLowerCase()));
  if (current.length !== 1) throw new Error("task PR must close the current managed Issue");
  for (const item of closing) {
    if (Number(item.number) === Number(currentIssue.number)) continue;
    if (item.repository?.nameWithOwner && item.repository.nameWithOwner.toLowerCase() !== repository.toLowerCase()) continue;
    const issue = await adapter.getIssue(repository, item.number);
    if (issue && (parseV2IssueIdentity(issue.body) || parseIdentity(issue.body))) {
      throw new Error("task PR must not close multiple managed Issues");
    }
  }
  return closing;
}

export async function preflightTaskSubmissionV2({ plan, planPath, repository, adapter, envelope, completion }) {
  const validation = validateV2Plan(plan, { sourcePath: planPath, requireApproval: true });
  if (envelope.repository.toLowerCase() !== repository.toLowerCase()) throw new Error("task envelope repository mismatch");
  validateTaskEnvelopeV2(envelope, { plan, validation });
  validateTaskCompletionV2(completion, envelope);
  if (completion.planDigest !== validation.digest) throw new Error("completion plan digest does not match the approved plan");
  const login = await automationLogin(adapter);
  const issue = (await adapter.listIssues(repository)).find((candidate) => {
    const identity = parseV2IssueIdentity(candidate.body);
    return createdBy(candidate, login) && identity?.planId === plan.plan.id && identity.planDigest === validation.digest
      && identity.kind === "task" && identity.taskId === envelope.taskId;
  });
  if (!issue) throw new Error(`Issue for ${envelope.taskId} is missing`);
  if (Number(issue.number) !== envelope.issueNumber || (issue.html_url || issue.url) !== envelope.issueUrl) {
    throw new Error("task envelope Issue identity mismatch");
  }
  const claims = eventsFor(await issueComments(adapter, repository, issue.number), plan.plan.id, envelope.taskId)
    .filter((entry) => entry.value.type === "claim" && entry.value.attemptId === envelope.attemptId)
    .sort(commentSort);
  if (!claims.length || claims[0].value.envelopeDigest !== v2RuntimeDigest(envelope)
    || !claims[0].value.envelope || v2RuntimeDigest(claims[0].value.envelope) !== claims[0].value.envelopeDigest
    || JSON.stringify(canonicalizeV2(claims[0].value.envelope)) !== JSON.stringify(canonicalizeV2(envelope))) {
    throw new Error("task completion does not match the authoritative claim envelope");
  }
  return { validation, login, issue };
}

export async function submitTaskV2({ plan, planPath, repository, adapter, envelope, completion, pr, clock = () => new Date() }) {
  const { issue, login } = await preflightTaskSubmissionV2({ plan, planPath, repository, adapter, envelope, completion });
  if (completion.status === "blocked") {
    const event = await appendEvent({ adapter, repository, issueNumber: issue.number, event: completionIssueEvent(completion, envelope, nowIso(clock)) });
    await setStatus({ adapter, repository, issue, status: "blocked" });
    return { status: "blocked", taskId: envelope.taskId, attemptId: envelope.attemptId, completionDigest: v2RuntimeDigest(completion), changed: event.created };
  }
  const repositoryInfo = await adapter.getRepository(repository);
  const owner = repository.split("/")[0];
  const branchPulls = await adapter.listPullRequests(repository, { state: "open", head: `${owner}:${envelope.branch}`, base: repositoryInfo.default_branch });
  if (branchPulls.length > 1) throw new Error(`multiple task PRs use branch ${envelope.branch}`);
  const pullRequest = branchPulls[0] || await adapter.createPullRequest(repository, {
    title: `[${envelope.taskId}] ${envelope.title}`,
    body: `Closes #${issue.number}\n\n<!-- iwf-task-pr:v2 ${JSON.stringify({ planId: envelope.planId, taskId: envelope.taskId, planDigest: envelope.planDigest, envelopeDigest: v2RuntimeDigest(envelope) })} -->\n\nCompletion evidence: ${v2RuntimeDigest(completion)}`,
    head: envelope.branch,
    base: repositoryInfo.default_branch,
    maintainer_can_modify: false,
  });
  const number = prNumber(pr || pullRequest.number);
  const authoritative = number === pullRequest.number ? pullRequest : await adapter.getPullRequest(repository, number);
  if (!createdBy(authoritative, login)) throw new Error("task pull request was not created by the automation identity");
  if (authoritative.state !== "open") throw new Error("task pull request must be open on submission");
  if (authoritative.head?.ref !== envelope.branch || authoritative.base?.ref !== repositoryInfo.default_branch) throw new Error("task pull request branch does not match envelope");
  if (authoritative.head?.sha !== completion.commitSha) throw new Error("task pull request head SHA does not match Runner completion");
  if (!new RegExp(`(?:^|\\s)Closes\\s+#${issue.number}(?=\\s|$)`, "i").test(authoritative.body || "")) throw new Error("task pull request must contain Closes #<current task>");
  const files = await adapter.listPullRequestFiles(repository, number);
  const allPaths = files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
  if (!allPaths.length || !allPaths.every((file) => isAllowedPath(file, envelope.allowedPaths))) {
    throw new Error("task pull request changed files outside allowedPaths");
  }
  const actualFiles = authoritativeChangedFiles(files);
  const reportedFiles = structuredClone(completion.changedFiles).sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(canonicalizeV2(actualFiles)) !== JSON.stringify(canonicalizeV2(reportedFiles))) {
    throw new Error("task completion changedFiles differ from the authoritative pull request");
  }
  await assertSingleManagedClosingIssue({ adapter, repository, pullRequest: authoritative, currentIssue: issue });
  const event = await appendEvent({ adapter, repository, issueNumber: issue.number, event: {
    ...completionIssueEvent(completion, envelope, nowIso(clock)),
    type: "submit", prNumber: number, prHeadSha: completion.commitSha,
  } });
  await setStatus({ adapter, repository, issue, status: "in-review" });
  return { status: "in-review", taskId: envelope.taskId, attemptId: envelope.attemptId, prNumber: number, prHeadSha: completion.commitSha, completionDigest: v2RuntimeDigest(completion), changed: event.created };
}

export async function recordReviewV2({ plan, planPath, repository, adapter, envelope, completion, issueNumber, review, clock = () => new Date() }) {
  const validation = validateV2Plan(plan, { sourcePath: planPath, requireApproval: true });
  if (envelope.repository.toLowerCase() !== repository.toLowerCase()) throw new Error("review envelope repository mismatch");
  validateTaskEnvelopeV2(envelope, { plan, validation });
  validateTaskCompletionV2(completion, envelope);
  validateTaskReview(review, { kind: review.kind, envelope, completion });
  const login = await automationLogin(adapter);
  const issue = await adapter.getIssue(repository, issueNumber);
  const identity = parseV2IssueIdentity(issue?.body);
  if (!createdBy(issue, login) || identity?.planId !== plan.plan.id || identity.planDigest !== validation.digest
    || identity.kind !== "task" || identity.taskId !== envelope.taskId || Number(issueNumber) !== envelope.issueNumber) {
    throw new Error("review Issue does not match the task envelope");
  }
  const submit = latest(eventsFor(await issueComments(adapter, repository, issueNumber), plan.plan.id, envelope.taskId), ["submit"]);
  if (!submit || submit.value.attemptId !== envelope.attemptId
    || submit.value.envelopeDigest !== v2RuntimeDigest(envelope)
    || submit.value.completionDigest !== v2RuntimeDigest(completion)
    || submit.value.prHeadSha !== completion.commitSha) {
    throw new Error("review does not match the authoritative task submission");
  }
  const event = await appendEvent({ adapter, repository, issueNumber, event: {
    type: "review", planId: envelope.planId, planDigest: envelope.planDigest, taskId: envelope.taskId,
    attemptId: envelope.attemptId, attempt: envelope.attempt, at: nowIso(clock), reviewKind: review.kind,
    review, reviewDigest: v2RuntimeDigest(review), prNumber: review.prNumber || null, prHeadSha: review.commitSha,
  } });
  return { recorded: event.created, reviewKind: review.kind, reviewDigest: v2RuntimeDigest(review) };
}

export async function blockReviewV2({ plan, planPath, repository, adapter, envelope, completion, reason, clock = () => new Date() }) {
  const validation = validateV2Plan(plan, { sourcePath: planPath, requireApproval: true });
  if (envelope.repository.toLowerCase() !== repository.toLowerCase()) throw new Error("review failure envelope repository mismatch");
  validateTaskEnvelopeV2(envelope, { plan, validation });
  validateTaskCompletionV2(completion, envelope);
  if (completion.status !== "completed") throw new Error("review failure requires a completed task result");
  const login = await automationLogin(adapter);
  const issue = (await adapter.listIssues(repository)).find((candidate) => {
    const identity = parseV2IssueIdentity(candidate.body);
    return createdBy(candidate, login) && identity?.planId === plan.plan.id && identity.planDigest === validation.digest
      && identity.kind === "task" && identity.taskId === envelope.taskId;
  });
  if (!issue || Number(issue.number) !== envelope.issueNumber) throw new Error("review failure Issue does not match the task envelope");
  const submit = latest(eventsFor(await issueComments(adapter, repository, issue.number), plan.plan.id, envelope.taskId), ["submit"]);
  if (!submit || submit.value.attemptId !== envelope.attemptId
    || submit.value.envelopeDigest !== v2RuntimeDigest(envelope)
    || submit.value.completionDigest !== v2RuntimeDigest(completion)
    || submit.value.prHeadSha !== completion.commitSha) {
    throw new Error("review failure does not match the authoritative task submission");
  }
  const safeReason = assertSafeRunnerText(reason || "an independent review job failed", "review failure reason");
  const event = await appendEvent({ adapter, repository, issueNumber: issue.number, event: {
    type: "block", planId: envelope.planId, planDigest: envelope.planDigest, taskId: envelope.taskId,
    attemptId: envelope.attemptId, attempt: envelope.attempt, at: nowIso(clock), kind: "verification",
    reason: safeReason, retryable: false,
  } });
  await setStatus({ adapter, repository, issue, status: "blocked" });
  return { status: "blocked", taskId: envelope.taskId, attemptId: envelope.attemptId, changed: event.created, reason: safeReason };
}

function checkGates(checks, required) {
  const byName = new Map((checks || []).map((check) => [check.name, check]));
  const missing = required.filter((name) => !byName.has(name));
  const pending = required.filter((name) => byName.get(name)?.state === "pending");
  const failing = required.filter((name) => byName.get(name)?.state === "failure");
  return { missing, pending, failing, ready: !missing.length && !pending.length && !failing.length };
}

async function applyPostMergeSideEffects({ adapter, repository, record, mergeSha }) {
  const applied = [];
  for (const sideEffect of record.execution.allowedSideEffects) {
    if (!sideEffect.startsWith("github:tag:")) continue;
    const tag = sideEffect.slice("github:tag:".length);
    let existing = null;
    try {
      existing = await adapter.getGitReference(repository, `tags/${tag}`);
    } catch (error) {
      if (error.httpStatus !== 404) throw error;
    }
    const existingSha = existing?.object?.sha || existing?.sha;
    if (existingSha && existingSha !== mergeSha) throw new Error(`release tag ${tag} already points to a different commit`);
    if (!existingSha) await adapter.createGitReference(repository, `refs/tags/${tag}`, mergeSha);
    applied.push({ type: "github-tag", tag, sha: mergeSha, created: !existingSha });
  }
  return applied;
}

async function completeIfMerged({ plan, validation, repository, adapter, context, envelope, completion, submit, reviews, clock }) {
  validateTaskEnvelopeV2(envelope, { plan, validation });
  validateTaskCompletionV2(completion, envelope);
  if (Number(context.issue.number) !== envelope.issueNumber
    || submit.value.envelopeDigest !== v2RuntimeDigest(envelope)
    || submit.value.completionDigest !== v2RuntimeDigest(completion)
    || submit.value.prHeadSha !== completion.commitSha) {
    throw new Error("task submission evidence changed after review started");
  }
  const pull = await adapter.getPullRequest(repository, submit.value.prNumber);
  const login = await automationLogin(adapter);
  if (!createdBy(pull, login)) throw new Error("task pull request identity changed after submission");
  if (pull.head?.sha !== submit.value.prHeadSha) throw new Error("task PR head changed after submission");
  if (pull.head?.ref !== envelope.branch || pull.base?.ref !== envelope.defaultBranch) throw new Error("task PR branches changed after submission");
  const pullFiles = await adapter.listPullRequestFiles(repository, pull.number);
  const allPaths = pullFiles.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
  if (!allPaths.length || !allPaths.every((file) => isAllowedPath(file, envelope.allowedPaths))) {
    throw new Error("task PR scope changed after submission");
  }
  const actualFiles = authoritativeChangedFiles(pullFiles);
  const reportedFiles = structuredClone(completion.changedFiles).sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(canonicalizeV2(actualFiles)) !== JSON.stringify(canonicalizeV2(reportedFiles))) {
    throw new Error("task PR files no longer match completion evidence");
  }
  await assertSingleManagedClosingIssue({ adapter, repository, pullRequest: pull, currentIssue: context.issue });
  const checks = checkGates(await adapter.listCommitChecks(repository, pull.head.sha), envelope.requiredChecks);
  if (checks.failing.length) throw new Error(`required checks failed: ${checks.failing.join(", ")}`);
  if (checks.missing.length || checks.pending.length) return { status: "pending", checks };
  for (const entry of reviews) {
    validateTaskReview(entry.value.review, { kind: entry.value.reviewKind, envelope, completion });
    if (entry.value.reviewDigest !== v2RuntimeDigest(entry.value.review) || entry.value.prHeadSha !== completion.commitSha) {
      throw new Error("review evidence digest or commit changed");
    }
  }
  const specReviews = reviews.filter((entry) => entry.value.reviewKind === "spec");
  const codeReviews = reviews.filter((entry) => entry.value.reviewKind === "code");
  if (!specReviews.length || !codeReviews.length) {
    return { status: "pending", checks, reviews: { spec: Boolean(specReviews.length), code: Boolean(codeReviews.length) } };
  }
  if (specReviews.length !== 1 || codeReviews.length !== 1) throw new Error("expected exactly one immutable review of each kind");
  if (specReviews[0].value.review.verdict !== "approved" || codeReviews[0].value.review.verdict !== "approved") {
    throw new Error("independent review rejected the task");
  }
  if (pull.merged !== true && !pull.merged_at) {
    const issueBeforeMerge = await adapter.getIssue(repository, context.issue.number);
    if (issueBeforeMerge.state === "closed") throw new Error("managed Issue was closed before the task PR merge");
    const branch = await adapter.getBranch(repository, envelope.defaultBranch);
    if ((branch.commit?.sha || branch.sha) !== envelope.baseRevision) throw new Error("default branch changed after the task was claimed");
    const merged = await adapter.mergePullRequest(repository, pull.number, { merge_method: "squash" });
    if (merged?.merged !== true) throw new Error("GitHub rejected the automatic squash merge");
    return { status: "merge-requested", checks };
  }
  const issue = await adapter.getIssue(repository, context.issue.number);
  if (issue.state !== "closed") return { status: "pending", checks, closure: "Issue has not closed yet" };
  if (pull.merged_at && issue.closed_at && Date.parse(issue.closed_at) < Date.parse(pull.merged_at)) {
    throw new Error("managed Issue closed before the task PR merge");
  }
  const mergeSha = pull.merge_commit_sha;
  if (context.record.execution.allowedSideEffects.some((item) => item.startsWith("github:tag:")) && !/^[0-9a-f]{40}$/.test(mergeSha || "")) {
    throw new Error("merged task PR did not expose a full merge commit SHA for release tagging");
  }
  const sideEffects = await applyPostMergeSideEffects({ adapter, repository, record: context.record, mergeSha });
  const event = await appendEvent({ adapter, repository, issueNumber: context.issue.number, event: {
    type: "complete", planId: envelope.planId, planDigest: envelope.planDigest, taskId: envelope.taskId,
    attemptId: envelope.attemptId, attempt: envelope.attempt, at: nowIso(clock), prNumber: pull.number,
    prHeadSha: pull.head.sha, completionDigest: v2RuntimeDigest(completion), envelopeDigest: v2RuntimeDigest(envelope),
    sideEffects,
  } });
  return { status: "complete", taskId: envelope.taskId, changed: event.created, checks };
}

export async function reconcileV2({ plan, planPath, repository, adapter = new GitHubAdapter({ retries: 2 }), clock = () => new Date(), sync = true }) {
  const validation = validateV2Plan(plan, { sourcePath: planPath, requireApproval: true });
  const info = await adapter.getRepository(repository);
  const synced = sync ? await syncV2Issues({ plan, planPath, repository, adapter, defaultBranch: info.default_branch }) : null;
  const login = await automationLogin(adapter);
  const issues = new Map((await adapter.listIssues(repository)).map((issue) => {
    const identity = parseV2IssueIdentity(issue.body);
    return [createdBy(issue, login) && identity?.planId === plan.plan.id && identity.planDigest === validation.digest ? identity.taskId : null, issue];
  }).filter(([id]) => id));
  const { contexts } = await taskContexts({ plan, repository, adapter, issues });
  const reports = [];
  for (const record of flattenV2Plan(plan).filter((item) => item.kind === "task")) {
    const context = contexts.get(record.id);
    const submit = latest(context.events, ["submit"]);
    const complete = latest(context.events, ["complete"]);
    const claim = latest(context.events, ["claim"]);
    const block = latest(context.events, ["block"]);
    if (complete && (!block || commentSort(block, complete) < 0)) {
      reports.push({ taskId: record.id, status: "closed" });
      continue;
    }
    if (claim && (!submit || commentSort(submit, claim) < 0) && (!block || commentSort(block, claim) < 0)) {
      const age = clock().getTime() - Date.parse(claim.value.at);
      if (age > record.execution.maxRuntimeSeconds * 1000) {
        await appendEvent({ adapter, repository, issueNumber: context.issue.number, event: {
          type: "block", planId: plan.plan.id, planDigest: validation.digest, taskId: record.id,
          attemptId: claim.value.attemptId, attempt: claim.value.attempt, at: nowIso(clock), kind: "stale",
          reason: "task heartbeat or runtime exceeded the approved limit", retryable: false,
        } });
        await setStatus({ adapter, repository, issue: context.issue, status: "blocked" });
        reports.push({ taskId: record.id, status: "blocked", reason: "stale" });
        return { repository, planId: plan.plan.id, digest: validation.digest, synced, reports, stopped: true };
      }
      reports.push({ taskId: record.id, status: "in-progress" });
      return { repository, planId: plan.plan.id, digest: validation.digest, synced, reports, stopped: true };
    }
    if (block && (!submit || commentSort(submit, block) < 0)) {
      reports.push({ taskId: record.id, status: "blocked", reason: block.value.reason });
      return { repository, planId: plan.plan.id, digest: validation.digest, synced, reports, stopped: true };
    }
    if (submit) {
      if (submit.value.completion?.status === "blocked") {
        reports.push({ taskId: record.id, status: "blocked", reason: submit.value.completion.block?.reason || submit.value.reason });
        return { repository, planId: plan.plan.id, digest: validation.digest, synced, reports, stopped: true };
      }
      const envelope = submit.value.envelope || null;
      if (!envelope) {
        reports.push({ taskId: record.id, status: "in-review", reason: "envelope is not embedded in submit event" });
        return { repository, planId: plan.plan.id, digest: validation.digest, synced, reports, stopped: true };
      }
      const reviews = context.events.filter((entry) => entry.value.type === "review"
        && entry.value.attemptId === submit.value.attemptId
        && entry.value.prHeadSha === submit.value.prHeadSha);
      try {
        const report = await completeIfMerged({ plan, validation, repository, adapter, context, envelope, completion: submit.value.completion, submit, reviews, clock });
        reports.push({ taskId: record.id, ...report });
        if (report.status !== "complete") return { repository, planId: plan.plan.id, digest: validation.digest, synced, reports, stopped: true };
        const tasks = flattenV2Plan(plan).filter((item) => item.kind === "task");
        const next = tasks[tasks.findIndex((item) => item.id === record.id) + 1];
        if (next) {
          const nextContext = contexts.get(next.id);
          if (nextContext && nextContext.issue.state !== "closed") await setStatus({ adapter, repository, issue: nextContext.issue, status: "ready" });
        }
        continue;
      } catch (error) {
        let reason = "task merge gate failed";
        try {
          reason = assertSafeRunnerText(error.message, "merge gate error");
        } catch {
          reason = "task merge gate failed without safe publishable details";
        }
        await appendEvent({ adapter, repository, issueNumber: context.issue.number, event: {
          type: "block", planId: plan.plan.id, planDigest: validation.digest, taskId: record.id,
          attemptId: submit.value.attemptId, attempt: submit.value.attempt, at: nowIso(clock), kind: "verification",
          reason, retryable: false,
        } });
        await setStatus({ adapter, repository, issue: context.issue, status: "blocked" });
        reports.push({ taskId: record.id, status: "blocked", reason });
        return { repository, planId: plan.plan.id, digest: validation.digest, synced, reports, stopped: true };
      }
    }
    if (context.issue.state === "closed") {
      await appendEvent({ adapter, repository, issueNumber: context.issue.number, event: {
        type: "block", planId: plan.plan.id, planDigest: validation.digest, taskId: record.id,
        at: nowIso(clock), kind: "verification", reason: "managed Issue was closed without validated task PR evidence", retryable: false,
      } });
      reports.push({ taskId: record.id, status: "blocked", reason: "manual or unverified Issue closure" });
      return { repository, planId: plan.plan.id, digest: validation.digest, synced, reports, stopped: true };
    }
    reports.push({ taskId: record.id, status: managedStatus(context.issue) });
    return { repository, planId: plan.plan.id, digest: validation.digest, synced, reports, stopped: true };
  }
  return { repository, planId: plan.plan.id, digest: validation.digest, synced, reports, stopped: false, status: "complete" };
}
