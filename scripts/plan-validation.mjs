#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import Ajv2020 from "ajv/dist/2020.js";

const schemaUrls = {
  "1.0": new URL("../.github/issue-plan.schema.json", import.meta.url),
  "1.1": new URL("../.github/issue-plan.v1.1.schema.json", import.meta.url),
};
const schemas = Object.fromEntries(
  Object.entries(schemaUrls).map(([version, url]) => [version, JSON.parse(fs.readFileSync(url, "utf8"))]),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const schemaValidators = Object.fromEntries(
  Object.entries(schemas).map(([version, schema]) => [version, ajv.compile(schema)]),
);

const expectedSchemaFile = {
  "1.0": "issue-plan.schema.json",
  "1.1": "issue-plan.v1.1.schema.json",
};

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalPlan(plan) {
  const withoutApproval = structuredClone(plan);
  delete withoutApproval.approval;
  return canonicalize(withoutApproval);
}

export function approvalDigest(plan) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalPlan(plan)), "utf8")
    .digest("hex");
}

function schemaVersionOf(plan) {
  const version = plan && typeof plan === "object" ? plan.schemaVersion : undefined;
  if (!Object.hasOwn(schemaValidators, version)) {
    throw new Error(`unsupported schemaVersion ${version ?? "<missing>"}`);
  }
  return version;
}

function schemaPathErrors(plan, version, sourcePath) {
  const errors = [];
  const declared = String(plan.$schema || "");
  const declaredFile = path.posix.basename(declared.split(/[?#]/, 1)[0]);
  if (declaredFile !== expectedSchemaFile[version]) {
    errors.push(`schema path must reference ${expectedSchemaFile[version]} for schemaVersion ${version}`);
    return errors;
  }
  if (declared.startsWith("http://") || declared.startsWith("https://")) {
    if (declared !== schemas[version].$id) errors.push(`schema URL must be ${schemas[version].$id}`);
  } else if (sourcePath) {
    const resolved = path.resolve(path.dirname(path.resolve(sourcePath)), declared);
    const expected = path.resolve(new URL(`../.github/${expectedSchemaFile[version]}`, import.meta.url).pathname);
    if (resolved !== expected) errors.push(`schema path does not resolve to ${expectedSchemaFile[version]}`);
  } else {
    const known = new Set([`../${expectedSchemaFile[version]}`, `../.github/${expectedSchemaFile[version]}`]);
    if (!known.has(declared)) errors.push(`schema path must be a repository-relative reference to ${expectedSchemaFile[version]}`);
  }
  return errors;
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function v11SemanticErrors(plan) {
  const errors = [];
  for (const record of plan.epics.flatMap((epic) => [epic, ...epic.tasks])) {
    const management = record.management;
    if (management?.dueDate && !validCalendarDate(management.dueDate)) {
      errors.push(`${record.id} has an invalid dueDate ${management.dueDate}`);
    }
    if (management?.estimateHours !== undefined && !Number.isFinite(management.estimateHours)) {
      errors.push(`${record.id} estimateHours must be finite`);
    }
    const execution = record.execution;
    if (!execution) continue;
    if (!execution.agent.trim()) errors.push(`${record.id} execution.agent cannot be blank`);
    if (execution.heartbeatIntervalSeconds > execution.maxRuntimeSeconds) {
      errors.push(`${record.id} heartbeatIntervalSeconds cannot exceed maxRuntimeSeconds`);
    }
    if (execution.allowedSideEffects.some((sideEffect) => !sideEffect.trim())) {
      errors.push(`${record.id} allowedSideEffects cannot contain blank values`);
    }
    if (execution.requiredChecks.some((check) => !check.trim())) {
      errors.push(`${record.id} requiredChecks cannot contain blank values`);
    }
  }
  return errors;
}

function semanticErrors(plan, version) {
  const errors = [];
  const ids = new Map();
  const epics = new Set();
  const tasks = new Set();
  const taskRecords = [];

  for (const epic of plan.epics) {
    if (ids.has(epic.id)) errors.push(`duplicate ID ${epic.id}`);
    ids.set(epic.id, { kind: "epic", epicId: epic.id });
    epics.add(epic.id);
    if (epic.dependsOn.length) errors.push(`Epic ${epic.id} cannot declare task dependencies`);
    for (const task of epic.tasks) {
      if (ids.has(task.id)) errors.push(`duplicate ID ${task.id}`);
      ids.set(task.id, { kind: "task", epicId: epic.id });
      tasks.add(task.id);
      taskRecords.push({ task, epicId: epic.id });
    }
  }

  const graph = new Map();
  for (const { task, epicId } of taskRecords) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) errors.push(`${task.id} references unknown dependency ${dependency}`);
      else if (!tasks.has(dependency)) errors.push(`${task.id} may depend only on a task, not ${dependency}`);
      if (dependency === task.id) errors.push(`${task.id} cannot depend on itself`);
    }
    graph.set(task.id, task.dependsOn);
    for (const allowedPath of task.allowedPaths) {
      if (allowedPath.includes("\\") || allowedPath.split("/").includes("")) {
        errors.push(`${task.id} has an invalid allowed path ${allowedPath}`);
      }
    }
    if (!epics.has(epicId)) errors.push(`${task.id} has no parent Epic`);
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
    for (const dependency of graph.get(id) || []) if (graph.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);

  if (version === "1.1") errors.push(...v11SemanticErrors(plan));

  const computed = approvalDigest(plan);
  if (plan.approval.status === "draft") {
    if (plan.approval.digest !== null) errors.push("draft approval.digest must be null");
    if (plan.approval.approvedAt !== null) errors.push("draft approval.approvedAt must be null");
    if (plan.approval.approvedBy !== null) errors.push("draft approval.approvedBy must be null");
  } else {
    if (!plan.approval.approvedAt) errors.push("approved approval.approvedAt is required");
    if (!plan.approval.approvedBy) errors.push("approved approval.approvedBy is required");
    if (plan.approval.digest !== computed) {
      errors.push(`approval digest mismatch: expected ${computed}, got ${plan.approval.digest}`);
    }
  }
  return { errors, computed };
}

export function validatePlan(plan, { requireApproval = false, sourcePath } = {}) {
  const version = schemaVersionOf(plan);
  const validateSchema = schemaValidators[version];
  if (!validateSchema(plan)) {
    const details = (validateSchema.errors || [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`);
    throw new Error(`schema validation failed: ${details.join("; ")}`);
  }
  const errors = schemaPathErrors(plan, version, sourcePath);
  const semantic = semanticErrors(plan, version);
  errors.push(...semantic.errors);
  const computed = semantic.computed;
  if (requireApproval && plan.approval.status !== "approved") {
    errors.push("plan approval.status must be approved");
  }
  if (errors.length) throw new Error(errors.join("; "));
  return { plan, digest: computed };
}

export function readPlan(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--plan") options.plan = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.plan) throw new Error("--plan is required");
  return options;
}

if (path.resolve(process.argv[1] || "") === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const plan = readPlan(options.plan);
    const result = validatePlan(plan, { sourcePath: options.plan });
    const tasks = plan.epics.reduce((count, epic) => count + epic.tasks.length, 0);
    console.log(JSON.stringify({
      valid: true,
      planId: plan.plan.id,
      digest: result.digest,
      status: plan.approval.status,
      epics: plan.epics.length,
      tasks,
    }, null, 2));
  } catch (error) {
    console.error(`plan validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
