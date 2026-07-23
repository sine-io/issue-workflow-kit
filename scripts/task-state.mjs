import { BLOCK_KINDS, marker, parseMarker } from "./runtime-domain.mjs";

export const STATUS_PREFIX = "status:";
export const RUNTIME_STATUS_LABELS = [
  "status:backlog",
  "status:ready",
  "status:in-progress",
  "status:blocked",
  "status:in-review",
];

export function labelNames(issue) {
  return (issue?.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean);
}

export function taskStatus(issue) {
  const statuses = labelNames(issue).filter((label) => label.startsWith(STATUS_PREFIX));
  if (statuses.length !== 1) throw new Error(`Issue #${issue?.number ?? "?"} must have exactly one status:* label`);
  return statuses[0].slice(STATUS_PREFIX.length);
}

export function labelsWithStatus(issue, status) {
  const desired = `status:${status}`;
  if (!RUNTIME_STATUS_LABELS.includes(desired)) throw new Error(`unsupported task status ${status}`);
  return [...new Set([...labelNames(issue).filter((label) => !label.startsWith(STATUS_PREFIX)), desired])];
}

export function compareComments(left, right) {
  const leftTime = Date.parse(left.created_at || left.createdAt || "") || 0;
  const rightTime = Date.parse(right.created_at || right.createdAt || "") || 0;
  if (leftTime !== rightTime) return leftTime - rightTime;
  const leftId = String(left.id ?? "0");
  const rightId = String(right.id ?? "0");
  if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
    const leftNumber = BigInt(leftId);
    const rightNumber = BigInt(rightId);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  return leftId.localeCompare(rightId);
}

export function attemptComments(comments) {
  const attempts = [];
  for (const comment of comments || []) {
    const value = parseMarker(comment.body, "attempt");
    if (!value) continue;
    attempts.push({ comment, value });
  }
  return attempts.sort((left, right) => compareComments(left.comment, right.comment));
}

export function eventComments(comments) {
  const events = [];
  for (const comment of comments || []) {
    const value = parseMarker(comment.body, "event");
    if (!value) continue;
    events.push({ comment, value });
  }
  return events.sort((left, right) => compareComments(left.comment, right.comment));
}

export function attemptFor(comments, attemptId, { current = false } = {}) {
  const matches = attemptComments(comments).filter((entry) => entry.value.attemptId === attemptId);
  if (!matches.length) return null;
  if (!current) return matches[0];
  return matches.find((entry) => !["superseded"].includes(entry.value.status)) || matches[0];
}

export function currentAttempt(comments) {
  const candidates = attemptComments(comments)
    .filter((entry) => ["in-progress", "blocked", "in-review"].includes(entry.value.status));
  if (!candidates.length) return null;
  candidates.sort((left, right) => {
    const attemptDelta = right.value.attempt - left.value.attempt;
    return attemptDelta || compareComments(left.comment, right.comment);
  });
  return candidates[0];
}

export function earliestClaim(comments, attemptId) {
  return attemptComments(comments)
    .filter((entry) => entry.value.attemptId === attemptId)
    .sort((left, right) => compareComments(left.comment, right.comment))[0] || null;
}

function safeText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (value.length > 1000 || value.split(/\r?\n/).length > 20) throw new Error(`${label} must not contain full logs`);
  if (/(?:^|\s)\/(?!\/)[^\s]+|(?:^|\s)[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`${label} must not contain a local absolute path`);
  }
  if (/(?:ghp_|github_pat_|sk-[A-Za-z0-9]|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/.test(value)) {
    throw new Error(`${label} appears to contain a secret`);
  }
  return value.trim();
}

export function validateNote(note) {
  if (note === undefined) return undefined;
  return safeText(note, "note");
}

export function validateBlock(kind, reason) {
  if (!BLOCK_KINDS.includes(kind)) throw new Error(`block kind must be one of ${BLOCK_KINDS.join("|")}`);
  return { kind, reason: safeText(reason, "reason") };
}

export function renderAttemptComment(attempt) {
  const lines = [
    `### Task attempt ${attempt.attempt}`,
    "",
    `- Attempt: \`${attempt.attemptId}\``,
    `- Agent: \`${attempt.agent}\``,
    `- Status: \`${attempt.status}\``,
    `- Branch: \`${attempt.envelope.branch}\``,
    `- Envelope: \`${attempt.envelopeDigest}\``,
    `- Last heartbeat: \`${attempt.heartbeatAt}\``,
  ];
  if (attempt.note) lines.push(`- Note: ${attempt.note}`);
  if (attempt.block) {
    lines.push(`- Block kind: \`${attempt.block.kind}\``);
    lines.push(`- Block reason: ${attempt.block.reason}`);
  }
  lines.push("", marker("attempt", attempt));
  return lines.join("\n");
}

export function renderEventComment(event) {
  const lines = [
    `### Task event: ${event.type}`,
    "",
    `- Attempt: \`${event.attemptId}\``,
    `- Recorded at: \`${event.at}\``,
  ];
  if (event.kind) lines.push(`- Kind: \`${event.kind}\``);
  if (event.reason) lines.push(`- Reason: ${event.reason}`);
  if (event.prNumber) lines.push(`- Pull request: #${event.prNumber}`);
  if (event.completionDigest) lines.push(`- Completion: \`${event.completionDigest}\``);
  lines.push("", marker("event", event));
  return lines.join("\n");
}

export function hasEvent(comments, predicate) {
  return eventComments(comments).some(({ value }) => predicate(value));
}
