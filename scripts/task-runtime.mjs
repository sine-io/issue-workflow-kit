import { createExecutionEnvelope, envelopeDigest, marker, parseMarker } from "./runtime-domain.mjs";
import { parseIdentity } from "./plan-domain.mjs";
import { validatePlan } from "./plan-validation.mjs";
import {
  pullRequestNumber,
  validateCompletionResult,
  validateExecutionEnvelope,
  validatePullRequestSubmission,
} from "./runtime-validation.mjs";
import {
  attemptComments,
  currentAttempt,
  earliestClaim,
  eventComments,
  hasEvent,
  labelsWithStatus,
  renderAttemptComment,
  renderEventComment,
  taskStatus,
  validateBlock,
  validateNote,
} from "./task-state.mjs";

function nowIso(clock) {
  const value = clock ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("clock returned an invalid date");
  return date.toISOString();
}

function issueUrl(issue) {
  return issue.html_url || issue.url;
}

function commentId(comment) {
  return String(comment?.id ?? "");
}

function taskRecord(plan, taskId) {
  for (const epic of plan.epics) {
    const task = epic.tasks.find((candidate) => candidate.id === taskId);
    if (task) return { ...structuredClone(task), kind: "task", parentId: epic.id, epicId: epic.id };
  }
  throw new Error(`task ${taskId} is not present in plan ${plan.plan.id}`);
}

function taskIdFromAttempt(attemptId) {
  const match = String(attemptId || "").match(/^(.+)-A\d{2,}$/);
  if (!match) throw new Error("attempt-id must end with -A followed by at least two digits");
  return match[1];
}

function planIssues(issues, planId) {
  const byId = new Map();
  for (const issue of issues) {
    const identity = parseIdentity(issue.body || "");
    if (!identity || identity.planId !== planId) continue;
    if (byId.has(identity.taskId)) throw new Error(`multiple Issues use identity ${planId}/${identity.taskId}`);
    byId.set(identity.taskId, issue);
  }
  return byId;
}

async function loadTaskContext({ plan, repository, taskId, adapter }) {
  validatePlan(plan, { requireApproval: true });
  const record = taskRecord(plan, taskId);
  const issues = await adapter.listIssues(repository);
  const byId = planIssues(issues, plan.plan.id);
  const issue = byId.get(taskId);
  if (!issue) throw new Error(`Issue for task ${taskId} was not found`);
  const comments = await adapter.listIssueComments(repository, issue.number);
  return { plan, repository, record, issues, byId, issue, comments, adapter };
}

function assertOpen(issue) {
  if (String(issue.state).toLowerCase() !== "open") throw new Error(`Issue #${issue.number} must be open`);
}

function assertDependenciesClosed(context) {
  const open = [];
  for (const dependency of context.record.dependsOn) {
    const issue = context.byId.get(dependency);
    if (!issue) throw new Error(`Issue for dependency ${dependency} was not found`);
    if (String(issue.state).toLowerCase() !== "closed") open.push(dependency);
  }
  if (open.length) throw new Error(`task dependencies are not closed: ${open.join(", ")}`);
}

async function createComment(context, body) {
  return context.adapter.createIssueComment(context.repository, context.issue.number, body);
}

async function updateComment(context, comment, body) {
  if (!comment?.id) throw new Error("managed attempt comment is missing an ID");
  return context.adapter.updateIssueComment(context.repository, comment.id, body);
}

async function setStatus(context, status) {
  const issue = typeof context.adapter.getIssue === "function"
    ? await context.adapter.getIssue(context.repository, context.issue.number)
    : context.issue;
  const current = taskStatus(issue);
  if (current === status) return issue;
  return context.adapter.updateIssue(context.repository, issue.number, { labels: labelsWithStatus(issue, status) });
}

function attemptRecord({ envelope, status, at, note, resumedFrom }) {
  return {
    schemaVersion: "task-attempt/v1",
    planId: envelope.planId,
    taskId: envelope.taskId,
    issueNumber: envelope.issueNumber,
    attemptId: envelope.attemptId,
    attempt: envelope.attempt,
    agent: envelope.agent,
    status,
    claimedAt: at,
    heartbeatAt: at,
    envelope,
    envelopeDigest: envelopeDigest(envelope),
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(note ? { note } : {}),
  };
}

function eventRecord({ type, attempt, at, ...details }) {
  return {
    schemaVersion: "task-event/v1",
    planId: attempt.planId,
    taskId: attempt.taskId,
    issueNumber: attempt.issueNumber,
    attemptId: attempt.attemptId,
    type,
    at,
    ...details,
  };
}

function validAttemptEntries(context, comments = context.comments) {
  return attemptComments(comments).filter((entry) => {
    try {
      const value = entry.value;
      if (value.planId !== context.plan.plan.id
        || value.taskId !== context.record.id
        || value.issueNumber !== context.issue.number
        || value.envelopeDigest !== envelopeDigest(value.envelope)) return false;
      validateExecutionEnvelope(value.envelope, { plan: context.plan, task: context.record });
      return true;
    } catch {
      return false;
    }
  });
}

async function writeEventOnce(context, event, comments) {
  const fresh = comments || await context.adapter.listIssueComments(context.repository, context.issue.number);
  const exists = hasEvent(fresh, (value) => value.type === event.type
    && value.planId === event.planId
    && value.taskId === event.taskId
    && value.issueNumber === event.issueNumber
    && value.attemptId === event.attemptId
    && (event.kind === undefined || value.kind === event.kind)
    && (event.prNumber === undefined || value.prNumber === event.prNumber));
  if (exists) return null;
  return createComment(context, renderEventComment(event));
}

async function supersedeConflict(context, created, value, winner, at) {
  const superseded = { ...value, status: "superseded", supersededAt: at, winnerCommentId: winner.comment.id };
  await updateComment(context, created, renderAttemptComment(superseded));
  await writeEventOnce(context, eventRecord({
    type: "superseded",
    attempt: superseded,
    at,
    winnerCommentId: winner.comment.id,
  }), context.comments);
  return {
    taskId: value.taskId,
    attemptId: value.attemptId,
    status: "superseded",
    winnerCommentId: winner.comment.id,
    changed: true,
  };
}

async function claimEnvelope(context, { attempt, agent, clock, resumedFrom }) {
  const at = nowIso(clock);
  const envelope = createExecutionEnvelope({
    plan: context.plan,
    record: context.record,
    issue: context.issue,
    attempt,
    agent,
  });
  validateExecutionEnvelope(envelope, { plan: context.plan, task: context.record });
  const value = attemptRecord({ envelope, status: "in-progress", at, resumedFrom });
  const created = await createComment(context, renderAttemptComment(value));
  const fresh = await context.adapter.listIssueComments(context.repository, context.issue.number);
  const validComments = validAttemptEntries(context, fresh).map((entry) => entry.comment);
  const winner = earliestClaim(validComments, value.attemptId);
  if (!winner) throw new Error("created claim comment could not be read back");
  if (commentId(winner.comment) !== commentId(created)) {
    return supersedeConflict(context, created, value, winner, at);
  }
  return { value, created, at };
}

export async function claimTask({ plan, repository, taskId, agent, adapter, clock }) {
  const context = await loadTaskContext({ plan, repository, taskId, adapter });
  assertOpen(context.issue);
  const validComments = validAttemptEntries(context).map((entry) => entry.comment);
  const active = currentAttempt(validComments);
  if (active?.value.status === "in-progress" && active.value.agent === agent) {
    const changed = taskStatus(context.issue) !== "in-progress";
    if (changed) await setStatus(context, "in-progress");
    return {
      taskId,
      attemptId: active.value.attemptId,
      status: "in-progress",
      branch: active.value.envelope.branch,
      envelope: active.value.envelope,
      envelopeDigest: active.value.envelopeDigest,
      commentId: active.comment.id,
      changed,
    };
  }
  if (active) throw new Error(`task ${taskId} already has current attempt ${active.value.attemptId}`);
  if (validAttemptEntries(context).length) throw new Error(`task ${taskId} has prior attempts and must be resumed`);
  if (taskStatus(context.issue) !== "ready") throw new Error(`task ${taskId} must have status:ready`);
  assertDependenciesClosed(context);

  const claim = await claimEnvelope(context, { attempt: 1, agent, clock });
  if (!claim.value) return claim;
  await setStatus(context, "in-progress");
  return {
    taskId,
    attemptId: claim.value.attemptId,
    status: "in-progress",
    branch: claim.value.envelope.branch,
    envelope: claim.value.envelope,
    envelopeDigest: claim.value.envelopeDigest,
    commentId: claim.created.id,
    changed: true,
  };
}

async function loadAttemptContext({ plan, repository, attemptId, adapter }) {
  const taskId = taskIdFromAttempt(attemptId);
  const context = await loadTaskContext({ plan, repository, taskId, adapter });
  const attempts = validAttemptEntries(context).filter((entry) => entry.value.attemptId === attemptId);
  const attempt = attempts.find((entry) => entry.value.status !== "superseded") || attempts[0];
  if (!attempt) throw new Error(`attempt ${attemptId} was not found`);
  validateExecutionEnvelope(attempt.value.envelope, { plan, task: context.record });
  if (attempt.value.envelopeDigest !== envelopeDigest(attempt.value.envelope)) {
    throw new Error(`attempt ${attemptId} envelope digest mismatch`);
  }
  return { ...context, attempt };
}

export async function heartbeatTask({ plan, repository, attemptId, note, adapter, clock }) {
  const context = await loadAttemptContext({ plan, repository, attemptId, adapter });
  assertOpen(context.issue);
  if (context.attempt.value.status !== "in-progress") {
    throw new Error(`attempt ${attemptId} is not in progress`);
  }
  if (taskStatus(context.issue) !== "in-progress") throw new Error(`task ${context.record.id} is not in progress`);
  const at = nowIso(clock);
  const value = {
    ...context.attempt.value,
    heartbeatAt: at,
    ...(note === undefined ? {} : { note: validateNote(note) }),
  };
  const body = renderAttemptComment(value);
  if (body === context.attempt.comment.body) {
    return { taskId: value.taskId, attemptId, status: value.status, heartbeatAt: value.heartbeatAt, changed: false };
  }
  await updateComment(context, context.attempt.comment, body);
  return { taskId: value.taskId, attemptId, status: value.status, heartbeatAt: value.heartbeatAt, changed: true };
}

export async function blockTask({ plan, repository, attemptId, kind, reason, adapter, clock }) {
  const context = await loadAttemptContext({ plan, repository, attemptId, adapter });
  assertOpen(context.issue);
  const block = validateBlock(kind, reason);
  if (context.attempt.value.status === "blocked") {
    if (context.attempt.value.block?.kind === block.kind && context.attempt.value.block?.reason === block.reason) {
      const at = context.attempt.value.blockedAt || nowIso(clock);
      const created = await writeEventOnce(
        context,
        eventRecord({ type: "block", attempt: context.attempt.value, at, ...block }),
        context.comments,
      );
      const labelChanged = taskStatus(context.issue) !== "blocked";
      if (labelChanged) await setStatus(context, "blocked");
      return { taskId: context.record.id, attemptId, status: "blocked", changed: Boolean(created || labelChanged) };
    }
    throw new Error(`attempt ${attemptId} is already blocked`);
  }
  if (context.attempt.value.status !== "in-progress") throw new Error(`attempt ${attemptId} is not in progress`);
  if (taskStatus(context.issue) !== "in-progress") throw new Error(`task ${context.record.id} is not in progress`);
  const at = nowIso(clock);
  const value = { ...context.attempt.value, status: "blocked", blockedAt: at, heartbeatAt: at, block };
  await updateComment(context, context.attempt.comment, renderAttemptComment(value));
  await writeEventOnce(context, eventRecord({ type: "block", attempt: value, at, ...block }), context.comments);
  await setStatus(context, "blocked");
  return { taskId: value.taskId, attemptId, status: "blocked", kind, reason: block.reason, changed: true };
}

export async function resumeTask({ plan, repository, taskId, fromAttempt, agent, adapter, clock }) {
  const context = await loadTaskContext({ plan, repository, taskId, adapter });
  assertOpen(context.issue);
  if (taskStatus(context.issue) !== "blocked") throw new Error(`task ${taskId} must have status:blocked`);
  const fromId = /^\d+$/.test(String(fromAttempt || ""))
    ? `${taskId}-A${String(Number(fromAttempt)).padStart(2, "0")}`
    : String(fromAttempt || "");
  const entries = validAttemptEntries(context);
  const existingResume = entries.find((entry) => entry.value.resumedFrom === fromId
    && entry.value.agent === agent
    && entry.value.status === "in-progress");
  if (existingResume) {
    const sourceAttempt = entries.find((entry) => entry.value.attemptId === fromId);
    let changed = false;
    const at = existingResume.value.claimedAt || nowIso(clock);
    if (sourceAttempt?.value.status === "blocked") {
      const superseded = {
        ...sourceAttempt.value,
        status: "superseded",
        supersededAt: at,
        resumedBy: existingResume.value.attemptId,
      };
      await updateComment(context, sourceAttempt.comment, renderAttemptComment(superseded));
      changed = true;
    }
    const created = await writeEventOnce(context, eventRecord({
      type: "resume",
      attempt: existingResume.value,
      at,
      fromAttempt: fromId,
    }), context.comments);
    changed ||= Boolean(created);
    if (taskStatus(context.issue) !== "in-progress") {
      await setStatus(context, "in-progress");
      changed = true;
    }
    return {
      taskId,
      attemptId: existingResume.value.attemptId,
      status: "in-progress",
      branch: existingResume.value.envelope.branch,
      envelope: existingResume.value.envelope,
      envelopeDigest: existingResume.value.envelopeDigest,
      changed,
    };
  }
  const source = entries.find((entry) => entry.value.attemptId === fromId && entry.value.status === "blocked");
  if (!source) {
    throw new Error(`blocked source attempt ${fromId} was not found`);
  }
  const next = source.value.attempt + 1;
  if (next > source.value.envelope.maxAttempts) {
    throw new Error(`attempt ${next} exceeds approved maxAttempts ${source.value.envelope.maxAttempts}`);
  }
  assertDependenciesClosed(context);
  const claim = await claimEnvelope(context, { attempt: next, agent, clock, resumedFrom: fromId });
  if (!claim.value) return claim;
  const superseded = { ...source.value, status: "superseded", supersededAt: claim.at, resumedBy: claim.value.attemptId };
  await updateComment(context, source.comment, renderAttemptComment(superseded));
  await writeEventOnce(context, eventRecord({
    type: "resume",
    attempt: claim.value,
    at: claim.at,
    fromAttempt: fromId,
  }), context.comments);
  await setStatus(context, "in-progress");
  return {
    taskId,
    attemptId: claim.value.attemptId,
    status: "in-progress",
    branch: claim.value.envelope.branch,
    envelope: claim.value.envelope,
    envelopeDigest: claim.value.envelopeDigest,
    changed: true,
  };
}

function allEvidenceSuccessful(result) {
  return [...result.acceptance, ...result.verification].every((entry) => entry.status === "success");
}

export async function submitTask({ plan, repository, attemptId, pr: prValue, result, adapter, clock }) {
  const context = await loadAttemptContext({ plan, repository, attemptId, adapter });
  assertOpen(context.issue);
  const completion = validateCompletionResult(result, {
    envelope: context.attempt.value.envelope,
    plan,
    task: context.record,
  });
  const prNumber = pullRequestNumber(prValue);
  const repositoryInfo = await adapter.getRepository(repository);
  const pullRequest = await adapter.getPullRequest(repository, prNumber);
  const files = await adapter.listPullRequestFiles(repository, prNumber);
  const prEvidence = validatePullRequestSubmission({
    pr: pullRequest,
    files,
    envelope: context.attempt.value.envelope,
    issue: context.issue,
    repository,
    defaultBranch: repositoryInfo.default_branch || repositoryInfo.defaultBranch,
    expectedNumber: prNumber,
  });

  const targetStatus = result.result === "success" ? "in-review" : "blocked";
  if (result.result === "success" && !allEvidenceSuccessful(result)) {
    throw new Error("success completion requires every acceptance and verification result to be success");
  }
  const previousSubmit = eventComments(context.comments).find(({ value }) => value.type === "submit"
    && value.planId === context.plan.plan.id
    && value.taskId === context.record.id
    && value.issueNumber === context.issue.number
    && value.attemptId === attemptId
    && value.prNumber === prNumber);
  if (previousSubmit?.value.completionDigest !== undefined
    && previousSubmit.value.completionDigest !== completion.digest) {
    throw new Error(`attempt ${attemptId} was already submitted with different completion evidence`);
  }
  const stored = context.attempt.value;
  const recovering = stored.status === targetStatus
    && stored.prNumber === prNumber
    && stored.prHeadSha === prEvidence.headSha
    && stored.completionDigest === completion.digest;
  if (!["in-progress", targetStatus].includes(stored.status) || (stored.status === targetStatus && !recovering)) {
    throw new Error(`attempt ${attemptId} is not in progress`);
  }
  if (stored.status === "in-progress" && taskStatus(context.issue) !== "in-progress") {
    throw new Error(`task ${context.record.id} is not in progress`);
  }

  const at = stored.submittedAt || nowIso(clock);
  const block = targetStatus === "blocked" ? {
    kind: "verification",
    reason: stored.block?.reason || validateNote(result.note || `completion result is ${result.result}`),
  } : null;
  const value = recovering ? stored : {
    ...stored,
    status: targetStatus,
    heartbeatAt: at,
    submittedAt: at,
    prNumber,
    prHeadSha: prEvidence.headSha,
    completionDigest: completion.digest,
    completionResult: result.result,
    ...(block ? { blockedAt: at, block } : {}),
  };
  const submitEvent = eventRecord({
    type: "submit",
    attempt: value,
    at,
    prNumber,
    prHeadSha: prEvidence.headSha,
    envelopeDigest: value.envelopeDigest,
    completionDigest: completion.digest,
    result: result.result,
  });

  let changed = false;
  if (!recovering) {
    await updateComment(context, context.attempt.comment, renderAttemptComment(value));
    changed = true;
  }
  const createdSubmit = await writeEventOnce(context, submitEvent, context.comments);
  changed ||= Boolean(createdSubmit);
  if (block) {
    const createdBlock = await writeEventOnce(context, eventRecord({
      type: "block",
      attempt: value,
      at,
      ...block,
      completionDigest: completion.digest,
    }), context.comments);
    changed ||= Boolean(createdBlock);
  }
  if (taskStatus(context.issue) !== targetStatus) {
    await setStatus(context, targetStatus);
    changed = true;
  }
  return {
    taskId: value.taskId,
    attemptId,
    status: targetStatus,
    prNumber,
    prHeadSha: prEvidence.headSha,
    completionDigest: completion.digest,
    changed,
  };
}

function latestAttemptForReconcile(comments) {
  return attemptComments(comments)
    .filter((entry) => ["in-progress", "blocked", "in-review", "complete"].includes(entry.value.status))
    .sort((left, right) => right.value.attempt - left.value.attempt)[0] || null;
}

function staleReason(attempt, now) {
  const heartbeatAt = Date.parse(attempt.heartbeatAt || attempt.claimedAt || "");
  const claimedAt = Date.parse(attempt.claimedAt || "");
  if (!Number.isFinite(heartbeatAt) || !Number.isFinite(claimedAt)) {
    throw new Error(`attempt ${attempt.attemptId} has invalid timestamps`);
  }
  const heartbeatAge = now - heartbeatAt;
  const runtimeAge = now - claimedAt;
  if (runtimeAge > attempt.envelope.maxRuntimeSeconds * 1000) return "maximum runtime exceeded";
  if (heartbeatAge > attempt.envelope.heartbeatIntervalSeconds * 1000) return "heartbeat interval exceeded";
  return null;
}

function evaluateChecks(checks, requiredChecks) {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const missing = requiredChecks.filter((name) => !byName.has(name));
  const pending = checks.filter((check) => check.state === "pending").map((check) => check.name);
  const failing = checks.filter((check) => check.state === "failure").map((check) => check.name);
  const requiredNotSuccessful = requiredChecks
    .filter((name) => byName.has(name) && byName.get(name).state !== "success");
  return {
    success: missing.length === 0 && pending.length === 0 && failing.length === 0 && requiredNotSuccessful.length === 0,
    missing,
    pending,
    failing,
    requiredNotSuccessful,
  };
}

function sourceIssueNumber(event) {
  return Number(
    event?.source?.issue?.number
    ?? event?.source?.pull_request?.number
    ?? event?.source?.number
    ?? event?.source_issue?.number,
  ) || null;
}

function closedByPullRequest(issue, timeline, pullRequest) {
  if (String(issue.state).toLowerCase() !== "closed") return false;
  const prNumber = Number(pullRequest.number);
  const closedEvents = timeline.filter((event) => event.event === "closed");
  if (closedEvents.some((event) => sourceIssueNumber(event) === prNumber)) return true;
  if (pullRequest.merge_commit_sha && closedEvents.some((event) => event.commit_id === pullRequest.merge_commit_sha)) return true;
  return false;
}

function completionEvidence(attempt, comments) {
  const submit = eventComments(comments).find(({ value }) => value.type === "submit"
    && value.planId === attempt.planId
    && value.taskId === attempt.taskId
    && value.issueNumber === attempt.issueNumber
    && value.attemptId === attempt.attemptId
    && value.prNumber === attempt.prNumber);
  if (!submit) throw new Error(`attempt ${attempt.attemptId} has no submit event`);
  if (submit.value.result !== "success") throw new Error(`attempt ${attempt.attemptId} was not submitted as success`);
  if (submit.value.completionDigest !== attempt.completionDigest) throw new Error(`attempt ${attempt.attemptId} completion digest mismatch`);
  if (submit.value.envelopeDigest !== attempt.envelopeDigest) throw new Error(`attempt ${attempt.attemptId} submit envelope digest mismatch`);
  if (attempt.envelopeDigest !== envelopeDigest(attempt.envelope)) throw new Error(`attempt ${attempt.attemptId} envelope digest mismatch`);
  return submit.value;
}

export async function reconcileTasks({ plan, repository, adapter, clock }) {
  validatePlan(plan, { requireApproval: true });
  const nowValue = Date.parse(nowIso(clock));
  const issues = await adapter.listIssues(repository);
  const byId = planIssues(issues, plan.plan.id);
  const repositoryInfo = await adapter.getRepository(repository);
  const defaultBranch = repositoryInfo.default_branch || repositoryInfo.defaultBranch;
  const snapshots = [];
  const reports = [];

  for (const epic of plan.epics) {
    for (const rawTask of epic.tasks) {
      const record = { ...structuredClone(rawTask), kind: "task", parentId: epic.id, epicId: epic.id };
      const issue = byId.get(record.id);
      if (!issue) throw new Error(`Issue for task ${record.id} was not found`);
      const comments = await adapter.listIssueComments(repository, issue.number);
      const attemptEntry = latestAttemptForReconcile(comments);
      const snapshot = { record, issue, comments, attemptEntry, stale: null, completion: null };
      snapshots.push(snapshot);
      if (!attemptEntry) {
        reports.push({ taskId: record.id, status: taskStatus(issue), evidence: "no-attempt" });
        continue;
      }
      validateExecutionEnvelope(attemptEntry.value.envelope, { plan, task: record });
      if (attemptEntry.value.envelopeDigest !== envelopeDigest(attemptEntry.value.envelope)) {
        throw new Error(`attempt ${attemptEntry.value.attemptId} envelope digest mismatch`);
      }

      if (attemptEntry.value.status === "in-progress") {
        const reason = staleReason(attemptEntry.value, nowValue);
        if (reason) snapshot.stale = { reason };
        reports.push({
          taskId: record.id,
          attemptId: attemptEntry.value.attemptId,
          status: reason ? "stale" : "in-progress",
          evidence: reason || "heartbeat-current",
        });
        continue;
      }
      if (attemptEntry.value.status === "blocked" && attemptEntry.value.block?.kind === "stale") {
        snapshot.stale = { reason: attemptEntry.value.block.reason, eventOnly: true };
        reports.push({ taskId: record.id, attemptId: attemptEntry.value.attemptId, status: "stale", evidence: "blocked-stale" });
        continue;
      }
      if (!["in-review", "complete"].includes(attemptEntry.value.status)) {
        reports.push({ taskId: record.id, attemptId: attemptEntry.value.attemptId, status: attemptEntry.value.status });
        continue;
      }

      let submit;
      try {
        submit = completionEvidence(attemptEntry.value, comments);
      } catch (error) {
        reports.push({ taskId: record.id, attemptId: attemptEntry.value.attemptId, status: "in-review", evidence: error.message });
        continue;
      }
      const pullRequest = await adapter.getPullRequest(repository, attemptEntry.value.prNumber);
      const files = await adapter.listPullRequestFiles(repository, attemptEntry.value.prNumber);
      let prEvidence;
      try {
        prEvidence = validatePullRequestSubmission({
          pr: pullRequest,
          files,
          envelope: attemptEntry.value.envelope,
          issue,
          repository,
          defaultBranch,
          expectedNumber: attemptEntry.value.prNumber,
          allowMerged: true,
        });
      } catch (error) {
        reports.push({ taskId: record.id, attemptId: attemptEntry.value.attemptId, status: "in-review", evidence: error.message });
        continue;
      }
      const headSha = pullRequest.head?.sha;
      const checks = await adapter.listCommitChecks(repository, headSha);
      const timeline = await adapter.listIssueTimeline(repository, issue.number);
      const closingIssues = typeof adapter.listPullRequestClosingIssues === "function"
        && (pullRequest.node_id || pullRequest.nodeId)
        ? await adapter.listPullRequestClosingIssues(pullRequest.node_id || pullRequest.nodeId)
        : null;
      const checkEvidence = evaluateChecks(checks, attemptEntry.value.envelope.requiredChecks);
      const merged = pullRequest.merged === true || Boolean(pullRequest.merged_at);
      const headUnchanged = attemptEntry.value.prHeadSha === headSha && submit.prHeadSha === headSha;
      const timelineClosure = closedByPullRequest(issue, timeline, pullRequest);
      const declaredClosingReference = closingIssues === null || closingIssues.some((candidate) => candidate.number === issue.number
        && (!candidate.repository?.nameWithOwner
          || candidate.repository.nameWithOwner.toLowerCase() === repository.toLowerCase()));
      const closure = timelineClosure && declaredClosingReference;
      const complete = merged && headUnchanged && checkEvidence.success && closure;
      snapshot.completion = {
        complete,
        pullRequest,
        prEvidence,
        checks,
        checkEvidence,
        merged,
        headUnchanged,
        closure,
      };
      reports.push({
        taskId: record.id,
        attemptId: attemptEntry.value.attemptId,
        status: complete ? "complete" : "in-review",
        evidence: {
          merged,
          headUnchanged,
          issueClosedByPullRequest: closure,
          checks: checkEvidence,
        },
      });
    }
  }

  const operations = [];
  const completed = new Set();
  for (const snapshot of snapshots) {
    const existingComplete = eventComments(snapshot.comments).some(({ value }) => value.type === "complete"
      && value.planId === plan.plan.id
      && value.taskId === snapshot.record.id
      && value.issueNumber === snapshot.issue.number
      && value.attemptId === snapshot.attemptEntry?.value.attemptId);
    if (snapshot.completion?.complete && existingComplete) completed.add(snapshot.record.id);
  }

  for (const snapshot of snapshots) {
    const { attemptEntry } = snapshot;
    if (!attemptEntry || !snapshot.stale) continue;
    const at = nowIso(clock);
    const block = { kind: "stale", reason: snapshot.stale.reason };
    const value = snapshot.stale.eventOnly
      ? attemptEntry.value
      : { ...attemptEntry.value, status: "blocked", blockedAt: at, heartbeatAt: at, block };
    if (!snapshot.stale.eventOnly) {
      await updateComment({ ...snapshot, adapter, repository }, attemptEntry.comment, renderAttemptComment(value));
      operations.push({ taskId: snapshot.record.id, action: "block-stale", attemptId: value.attemptId });
    }
    const event = eventRecord({ type: "stale", attempt: value, at, ...block });
    const created = await writeEventOnce({ ...snapshot, adapter, repository }, event, snapshot.comments);
    if (created) operations.push({ taskId: snapshot.record.id, action: "stale-event", attemptId: value.attemptId });
    if (taskStatus(snapshot.issue) !== "blocked") {
      await adapter.updateIssue(repository, snapshot.issue.number, { labels: labelsWithStatus(snapshot.issue, "blocked") });
      operations.push({ taskId: snapshot.record.id, action: "set-blocked" });
    }
  }

  for (const snapshot of snapshots) {
    const { attemptEntry } = snapshot;
    if (!attemptEntry || !snapshot.completion?.complete) continue;
    const at = nowIso(clock);
    const value = attemptEntry.value.status === "complete"
      ? attemptEntry.value
      : { ...attemptEntry.value, status: "complete", completedAt: at };
    if (attemptEntry.value.status !== "complete") {
      await updateComment({ ...snapshot, adapter, repository }, attemptEntry.comment, renderAttemptComment(value));
      operations.push({ taskId: snapshot.record.id, action: "mark-complete", attemptId: value.attemptId });
    }
    const event = eventRecord({
      type: "complete",
      attempt: value,
      at,
      prNumber: value.prNumber,
      completionDigest: value.completionDigest,
      checks: value.envelope.requiredChecks,
    });
    const created = await writeEventOnce({ ...snapshot, adapter, repository }, event, snapshot.comments);
    if (created) operations.push({ taskId: snapshot.record.id, action: "complete-event", attemptId: value.attemptId });
    completed.add(snapshot.record.id);
  }

  for (const snapshot of snapshots) {
    if (String(snapshot.issue.state).toLowerCase() !== "open") continue;
    if (taskStatus(snapshot.issue) !== "backlog") continue;
    if (!snapshot.record.dependsOn.length) continue;
    if (!snapshot.record.dependsOn.every((dependency) => completed.has(dependency))) continue;
    await adapter.updateIssue(repository, snapshot.issue.number, { labels: labelsWithStatus(snapshot.issue, "ready") });
    operations.push({ taskId: snapshot.record.id, action: "set-ready" });
  }

  return { repository, planId: plan.plan.id, operations, reports };
}

export async function getAttempt({ plan, repository, attemptId, adapter }) {
  const context = await loadAttemptContext({ plan, repository, attemptId, adapter });
  return {
    task: context.record,
    issue: context.issue,
    comments: context.comments,
    attempt: context.attempt,
  };
}

export { marker, parseMarker };
