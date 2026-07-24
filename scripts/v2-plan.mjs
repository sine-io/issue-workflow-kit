#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

const schemaUrl = new URL("../.github/iwf-plan.v2.schema.json", import.meta.url);
const schema = JSON.parse(fs.readFileSync(schemaUrl, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value) => !Number.isNaN(Date.parse(value)) && /Z$/.test(value),
});
const validateSchema = ajv.compile(schema);

export const V2_SCHEMA_VERSION = "2.0";
export const V2_SCHEMA_FILE = "iwf-plan.v2.schema.json";

export function canonicalizeV2(value) {
  if (Array.isArray(value)) return value.map(canonicalizeV2);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeV2(value[key])]));
  }
  return value;
}

export function canonicalV2Plan(plan) {
  const copy = structuredClone(plan);
  delete copy.approval;
  return canonicalizeV2(copy);
}

export function v2PlanDigest(plan) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalV2Plan(plan)), "utf8")
    .digest("hex");
}

export function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function markdownSections(source) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const requirements = new Map();
  let current = null;
  let section = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(REQ-[0-9]{3})\s*:\s*(.+?)\s*$/);
    if (heading) {
      if (requirements.has(heading[1])) throw new Error(`behavior contract repeats ${heading[1]}`);
      current = { id: heading[1], title: heading[2], sections: new Map() };
      requirements.set(current.id, current);
      section = null;
      continue;
    }
    const subsection = line.match(/^###\s+(.+?)\s*$/);
    if (subsection && current) {
      section = subsection[1].toLowerCase();
      if (!["behavior", "boundaries", "exceptions", "unacceptable behavior"].includes(section)) {
        throw new Error(`${current.id} unknown behavior contract section '${section}'; expected behavior, boundaries, exceptions, or unacceptable behavior`);
      }
      if (current.sections.has(section)) throw new Error(`${current.id} behavior contract repeats section '${section}'`);
      current.sections.set(section, []);
      continue;
    }
    if (current && section) current.sections.get(section).push(line);
  }
  return requirements;
}

function meaningful(lines) {
  return lines.join("\n").replace(/<!--.*?-->/gs, "").trim().length > 0;
}

export function parseBehaviorContract(source) {
  const requirements = markdownSections(source);
  if (!requirements.size) throw new Error("behavior contract must contain at least one ## REQ-NNN heading");
  for (const requirement of requirements.values()) {
    for (const section of ["behavior", "boundaries", "exceptions", "unacceptable behavior"]) {
      if (!meaningful(requirement.sections.get(section) || [])) {
        throw new Error(`${requirement.id} behavior contract section '${section}' is required`);
      }
    }
  }
  return [...requirements.values()].map((requirement) => {
    const sections = Object.fromEntries([...requirement.sections.entries()].map(([key, value]) => [key, value.join("\n").trim()]));
    const listSection = (name) => sections[name].split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      if (!line.startsWith("- ")) throw new Error(`${requirement.id} behavior contract section '${name}' must contain Markdown bullet items`);
      return line.slice(2).trim();
    });
    return {
      id: requirement.id,
      title: requirement.title,
      sections,
      behavior: sections.behavior,
      boundaries: listSection("boundaries"),
      exceptions: listSection("exceptions"),
      unacceptableBehavior: listSection("unacceptable behavior"),
    };
  });
}

function schemaErrors() {
  return (validateSchema.errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}

function resolveContractPath(plan, sourcePath) {
  if (!sourcePath) return null;
  const root = path.dirname(path.resolve(sourcePath));
  const contractPath = path.resolve(root, plan.contract.path);
  const relative = path.relative(root, contractPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("contract.path must stay beside or below the plan");
  const realRoot = fs.realpathSync(root);
  const realContract = fs.realpathSync(contractPath);
  const realRelative = path.relative(realRoot, realContract);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("contract.path symbolic link escapes the plan directory");
  return contractPath;
}

function recordList(plan) {
  return plan.epics.flatMap((epic) => [
    { ...epic, kind: "epic", parentId: null },
    ...epic.tasks.map((task) => ({ ...task, kind: "task", parentId: epic.id })),
  ]);
}

function traceabilityErrors(plan, contractRequirements) {
  const errors = [];
  const requirements = new Map();
  for (const requirement of plan.requirements) {
    if (requirements.has(requirement.id)) errors.push(`duplicate requirement ID ${requirement.id}`);
    requirements.set(requirement.id, requirement);
    const criterionIds = new Set();
    for (const criterion of requirement.acceptanceCriteria) {
      if (criterion.id !== `${requirement.id}-${criterion.id.slice(requirement.id.length + 1)}`) {
        errors.push(`${requirement.id} acceptance ID ${criterion.id} must be scoped to the requirement`);
      }
      if (criterionIds.has(criterion.id)) errors.push(`duplicate acceptance ID ${criterion.id}`);
      criterionIds.add(criterion.id);
    }
  }

  const contractIds = new Set(contractRequirements.map((requirement) => requirement.id));
  for (const requirement of plan.requirements) {
    if (!contractIds.has(requirement.id)) errors.push(`${requirement.id} is missing from behavior contract`);
    else {
      const contract = contractRequirements.find((item) => item.id === requirement.id);
      if (contract.title !== requirement.title) errors.push(`${requirement.id} title differs from behavior contract`);
      if (contract.behavior !== requirement.behavior) errors.push(`${requirement.id} behavior differs from behavior contract`);
      if (JSON.stringify(contract.boundaries) !== JSON.stringify(requirement.boundaries)) errors.push(`${requirement.id} boundaries differ from behavior contract`);
      if (JSON.stringify(contract.exceptions) !== JSON.stringify(requirement.exceptions)) errors.push(`${requirement.id} exceptions differ from behavior contract`);
      if (JSON.stringify(contract.unacceptableBehavior) !== JSON.stringify(requirement.unacceptableBehavior)) errors.push(`${requirement.id} unacceptableBehavior differs from behavior contract`);
    }
  }
  for (const id of contractIds) if (!requirements.has(id)) errors.push(`behavior contract contains undeclared ${id}`);

  const records = recordList(plan);
  const ids = new Set();
  const taskIds = new Set();
  const dependencyGraph = new Map();
  const taskAcceptance = new Set();
  const verificationIds = new Set();
  for (const record of records) {
    if (ids.has(record.id)) errors.push(`duplicate ID ${record.id}`);
    ids.add(record.id);
    if (record.kind === "epic") {
      if (record.dependsOn.length) errors.push(`Epic ${record.id} cannot declare dependencies`);
      continue;
    }
    taskIds.add(record.id);
    dependencyGraph.set(record.id, record.dependsOn);
    for (const dependency of record.dependsOn) {
      if (!taskIds.has(dependency) && !records.some((candidate) => candidate.id === dependency && candidate.kind === "task")) {
        errors.push(`${record.id} references unknown task dependency ${dependency}`);
      }
    }
    for (const requirementId of record.requirementIds) {
      if (!requirements.has(requirementId)) errors.push(`${record.id} references unknown requirement ${requirementId}`);
    }
    for (const criterion of record.acceptanceCriteria) {
      if (!record.requirementIds.includes(criterion.requirementId)) {
        errors.push(`${record.id} acceptance ${criterion.id} references an undeclared requirement`);
      }
      if (taskAcceptance.has(criterion.id)) errors.push(`duplicate task acceptance ID ${criterion.id}`);
      taskAcceptance.add(criterion.id);
    }
    for (const verification of record.verificationSteps) {
      if (verificationIds.has(verification.id)) errors.push(`duplicate verification ID ${verification.id}`);
      verificationIds.add(verification.id);
      for (const requirementId of verification.requirementIds) {
        if (!record.requirementIds.includes(requirementId)) errors.push(`${verification.id} references an undeclared requirement`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`dependency cycle detected at ${id}`);
      return;
    }
    visiting.add(id);
    for (const dependency of dependencyGraph.get(id) || []) if (dependencyGraph.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of dependencyGraph.keys()) visit(id);

  const serialTasks = records.filter((record) => record.kind === "task");
  for (let index = 1; index < serialTasks.length; index += 1) {
    const previous = serialTasks[index - 1];
    const current = serialTasks[index];
    if (!current.dependsOn.includes(previous.id)) {
      errors.push(`${current.id} must depend on preceding task ${previous.id} to enforce serial execution`);
    }
  }

  for (const requirement of plan.requirements) {
    const referenced = records.filter((record) => record.kind === "task" && record.requirementIds.includes(requirement.id));
    if (!referenced.length) errors.push(`${requirement.id} is not assigned to a task`);
    const requirementAcceptanceIds = new Set(requirement.acceptanceCriteria.map((criterion) => criterion.id));
    const taskStatements = referenced.flatMap((record) => record.acceptanceCriteria.filter((criterion) => criterion.requirementId === requirement.id));
    if (!taskStatements.length) errors.push(`${requirement.id} has no task acceptance evidence`);
    for (const criterion of requirement.acceptanceCriteria) {
      if (!taskStatements.some((taskCriterion) => taskCriterion.statement === criterion.statement)) {
        errors.push(`${criterion.id} has no traceable task acceptance statement`);
      }
    }
    if (!requirementAcceptanceIds.size) errors.push(`${requirement.id} must have acceptance criteria`);
  }
  return errors;
}

function pathPatternCovers(file, pattern) {
  return pattern === file || (pattern.endsWith("/**") && file.startsWith(`${pattern.slice(0, -3)}/`));
}

function protectedPathErrors(plan, sourcePath) {
  const errors = [];
  const protectedPaths = [];
  if (sourcePath) {
    const normalized = path.resolve(sourcePath).split(path.sep).join("/");
    const marker = "/.github/issue-plans/";
    const index = normalized.lastIndexOf(marker);
    if (index !== -1) {
      const planFile = normalized.slice(index + 1);
      protectedPaths.push(planFile, path.posix.join(path.posix.dirname(planFile), plan.contract.path));
    }
  }
  for (const task of plan.epics.flatMap((epic) => epic.tasks)) {
    for (const sideEffect of task.execution.allowedSideEffects) {
      if (sideEffect.startsWith("github:tag:") && !/^github:tag:v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(sideEffect)) {
        errors.push(`${task.id} declares an invalid GitHub release tag side effect`);
      }
    }
    for (const allowed of task.allowedPaths) {
      if (allowed === ".git" || allowed.startsWith(".git/")) errors.push(`${task.id} cannot allow Git metadata path ${allowed}`);
      for (const protectedPath of protectedPaths) {
        if (pathPatternCovers(protectedPath, allowed)) errors.push(`${task.id} allowedPaths cannot include approved plan artifact ${protectedPath}`);
      }
    }
  }
  return errors;
}

export function flattenV2Plan(plan) {
  return recordList(plan);
}

export function validateV2Plan(plan, { sourcePath, requireApproval = false, contractSource } = {}) {
  if (!plan || plan.schemaVersion !== V2_SCHEMA_VERSION) throw new Error(`unsupported v2 schemaVersion ${plan?.schemaVersion ?? "<missing>"}`);
  if (!validateSchema(plan)) throw new Error(`v2 schema validation failed: ${schemaErrors().join("; ")}`);
  const declaredSchema = path.posix.basename(String(plan.$schema).split(/[?#]/, 1)[0]);
  if (declaredSchema !== V2_SCHEMA_FILE) throw new Error(`schema path must reference ${V2_SCHEMA_FILE}`);
  if (sourcePath && !String(plan.$schema).startsWith("http")) {
    const resolved = path.resolve(path.dirname(path.resolve(sourcePath)), plan.$schema);
    if (resolved !== path.resolve(schemaUrl.pathname)) throw new Error(`schema path does not resolve to ${V2_SCHEMA_FILE}`);
  } else if (String(plan.$schema).startsWith("http") && plan.$schema !== schema.$id) {
    throw new Error(`schema URL must be ${schema.$id}`);
  }

  let contractText = contractSource;
  const contractPath = resolveContractPath(plan, sourcePath);
  if (contractText === undefined && contractPath) contractText = fs.readFileSync(contractPath, "utf8");
  if (contractText === undefined) throw new Error("sourcePath or contractSource is required to validate the behavior contract");
  const actualContractDigest = sha256Text(contractText);
  if (actualContractDigest !== plan.contract.sha256.toLowerCase()) {
    throw new Error(`behavior contract digest mismatch: expected ${plan.contract.sha256}, got ${actualContractDigest}`);
  }
  const contractRequirements = parseBehaviorContract(contractText);
  const errors = [...traceabilityErrors(plan, contractRequirements), ...protectedPathErrors(plan, sourcePath)];
  const digest = v2PlanDigest(plan);
  if (plan.approval.status === "draft") {
    if (plan.approval.digest !== null || plan.approval.approvedAt !== null || plan.approval.approvedBy !== null) {
      errors.push("draft approval fields must be null");
    }
  } else {
    if (!plan.approval.approvedAt || !plan.approval.approvedBy) errors.push("approved plan requires approvedAt and approvedBy");
    if (plan.approval.digest !== digest) errors.push(`approval digest mismatch: expected ${digest}, got ${plan.approval.digest}`);
  }
  if (requireApproval && plan.approval.status !== "approved") errors.push("plan approval.status must be approved");
  if (errors.length) throw new Error(errors.join("; "));
  return {
    plan,
    digest,
    contractDigest: actualContractDigest,
    contractPath,
    requirementIds: plan.requirements.map((requirement) => requirement.id),
    records: flattenV2Plan(plan),
  };
}

export function readV2Plan(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}
