import fs from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

import { assertSafeRunnerText, v2RuntimeDigest } from "./v2-runner-protocol.mjs";

const reviewSchema = JSON.parse(fs.readFileSync(new URL("../.github/task-review.v2.schema.json", import.meta.url), "utf8"));
const agentSchema = JSON.parse(fs.readFileSync(new URL("../.github/review-agent-output.v2.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", { type: "string", validate: (value) => !Number.isNaN(Date.parse(value)) && /Z$/.test(value) });
const validateSchema = ajv.compile(reviewSchema);
const validateAgentSchema = ajv.compile(agentSchema);

function errorsFor(validator) {
  return (validator.errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

function validateFindings(findings, kind, envelope, completion) {
  const changed = new Set(completion.changedFiles.flatMap((file) => [file.path, file.previousPath].filter(Boolean)));
  for (const finding of findings) {
    assertSafeRunnerText(finding.message, "review finding");
    if (finding.path && !changed.has(finding.path)) throw new Error(`review finding path is not in the fixed commit: ${finding.path}`);
    if (kind === "spec" && !finding.requirementIds.length) throw new Error("spec findings must identify at least one requirement");
    for (const requirementId of finding.requirementIds) {
      if (!envelope.requirementIds.includes(requirementId)) throw new Error(`review finding references unknown ${requirementId}`);
    }
  }
}

function verdictSemantics(value) {
  const serious = value.findings.some((finding) => ["blocker", "high"].includes(finding.severity));
  if (serious && value.verdict !== "changes-requested") throw new Error("blocker or high findings require changes-requested");
  if (value.verdict === "approved" && serious) throw new Error("approved review cannot contain serious findings");
}

export function reviewPromptRevision(kind) {
  return `${kind}-review-prompt/v1`;
}

export function validateReviewAgentOutput(output, { kind, envelope, completion }) {
  if (!validateAgentSchema(output)) throw new Error(`review agent output schema validation failed: ${errorsFor(validateAgentSchema)}`);
  assertSafeRunnerText(output.summary, "review summary");
  validateFindings(output.findings, kind, envelope, completion);
  verdictSemantics(output);
  return output;
}

export function createTaskReview({ kind, envelope, completion, output, reviewedAt }) {
  validateReviewAgentOutput(output, { kind, envelope, completion });
  return {
    schemaVersion: "task-review/v2",
    kind,
    planId: envelope.planId,
    planDigest: envelope.planDigest,
    taskId: envelope.taskId,
    envelopeDigest: v2RuntimeDigest(envelope),
    commitSha: completion.commitSha,
    verdict: output.verdict,
    summary: output.summary,
    findings: structuredClone(output.findings),
    runner: structuredClone(envelope.runner),
    reviewPromptRevision: reviewPromptRevision(kind),
    reviewedAt,
  };
}

export function validateTaskReview(review, { kind, envelope, completion }) {
  if (!validateSchema(review)) throw new Error(`task review schema validation failed: ${errorsFor(validateSchema)}`);
  if (review.kind !== kind) throw new Error(`expected ${kind} review`);
  for (const key of ["planId", "planDigest", "taskId"]) if (review[key] !== envelope[key]) throw new Error(`review ${key} mismatch`);
  if (review.envelopeDigest !== v2RuntimeDigest(envelope)) throw new Error("review envelopeDigest mismatch");
  if (review.commitSha !== completion.commitSha) throw new Error("review is not for the submitted commit SHA");
  if (JSON.stringify(review.runner) !== JSON.stringify(envelope.runner)) throw new Error("review Runner metadata mismatch");
  if (review.reviewPromptRevision !== reviewPromptRevision(kind)) throw new Error("review prompt revision mismatch");
  const output = { verdict: review.verdict, summary: review.summary, findings: review.findings };
  validateReviewAgentOutput(output, { kind, envelope, completion });
  return { review, digest: v2RuntimeDigest(review) };
}

export { agentSchema as reviewAgentOutputSchema };
