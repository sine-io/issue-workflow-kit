import { identityMarker } from "./plan-domain.mjs";

export const MANAGED_START = "<!-- issue-workflow-managed:start -->";
export const MANAGED_END = "<!-- issue-workflow-managed:end -->";

function refText(id, refs) {
  const ref = refs?.get(id);
  if (!ref) return `\`${id}\``;
  if (typeof ref === "number") return `#${ref} (\`${id}\`)`;
  return ref.number ? `#${ref.number} (\`${id}\`)` : `\`${id}\``;
}

function list(values, { checkbox = false, code = false } = {}) {
  const entries = values?.length ? values : ["None"];
  return entries.map((value) => {
    const rendered = code ? `\`${value}\`` : value;
    return `- ${checkbox ? "[ ] " : ""}${rendered}`;
  }).join("\n");
}

function relationships(record, refs, reverse) {
  const parent = record.parentId ? refText(record.parentId, refs) : "None";
  const blockedBy = record.dependsOn.length
    ? record.dependsOn.map((id) => refText(id, refs)).join(", ")
    : "None";
  const blocks = (reverse.get(record.id) || []).length
    ? reverse.get(record.id).map((id) => refText(id, refs)).join(", ")
    : "None";
  const children = record.kind === "epic"
    ? record.tasks.map((task) => `- ${refText(task.id, refs)} ${task.title}`).join("\n")
    : "None";
  return [
    `- Parent Epic: ${parent}`,
    `- Blocked by: ${blockedBy}`,
    `- Blocks: ${blocks}`,
    `- Native Sub-issues:\n${children}`,
  ].join("\n");
}

export function renderManagedBody(plan, record, refs = new Map(), reverse = new Map()) {
  return [
    MANAGED_START,
    identityMarker(plan, record),
    `> Plan: \`${plan.plan.id}\`  `,
    `> Item: \`${record.id}\`  `,
    `> Priority: \`${record.priority}\`  `,
    `> Type: ${record.kind === "epic" ? "Epic" : "Task"}`,
    "",
    "## Goal",
    "",
    record.goal,
    "",
    "## User value",
    "",
    record.value,
    "",
    "## Context",
    "",
    record.context,
    "",
    "## Expected behavior",
    "",
    record.expectedBehavior,
    "",
    "## Scope",
    "",
    list(record.scope, { checkbox: true }),
    "",
    "## Allowed paths",
    "",
    list(record.allowedPaths, { code: true }),
    "",
    "## Out of scope",
    "",
    list(record.outOfScope),
    "",
    "## Native relationships",
    "",
    relationships(record, refs, reverse),
    "",
    "## Acceptance criteria",
    "",
    list(record.acceptanceCriteria, { checkbox: true }),
    "",
    "## Verification",
    "",
    list(record.verificationSteps, { checkbox: true, code: true }),
    "",
    "## Stop conditions",
    "",
    "Stop on a failed check, unresolved dependency, approval digest mismatch, API or GraphQL error, or any requested change outside the allowed paths. Do not start the next task until this Issue is closed by its squash PR.",
    MANAGED_END,
  ].join("\n");
}

export function mergeManagedBody(existingBody, managedBody) {
  const existing = String(existingBody || "");
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if ((start === -1) !== (end === -1)) {
    throw new Error("issue contains an incomplete managed body block");
  }
  if (start !== -1 && end < start) throw new Error("issue managed body markers are out of order");
  if (start === -1) return existing.trim() ? `${managedBody}\n\n${existing.trim()}\n` : `${managedBody}\n`;
  const suffixStart = end + MANAGED_END.length;
  const prefix = existing.slice(0, start).replace(/\s+$/, "");
  const suffix = existing.slice(suffixStart).replace(/^\s+/, "");
  const merged = [prefix, managedBody, suffix].filter(Boolean).join("\n\n");
  return suffix ? merged : `${merged}\n`;
}
