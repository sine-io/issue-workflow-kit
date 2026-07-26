import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { validatePlan } from "./plan-validation.mjs";
import {
  CONFIG_PATH,
  CALLER_WORKFLOW_PATH,
  assertCallerMatchesConfig,
  assertPlanMatchesConfig,
  findPlanFiles,
  readConfig,
} from "./v2-config.mjs";

function runGit(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

function relativeGitPath(root, file) {
  const relative = path.relative(root, path.resolve(file)).split(path.sep).join("/");
  if (!relative || relative.startsWith("../")) throw new Error(`plan is outside repository: ${file}`);
  const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error(`plan symbolic link escapes repository: ${file}`);
  return relative;
}

function previousFile(root, ref, relative) {
  const result = runGit(root, ["show", `${ref}:${relative}`]);
  if (result.status === 0) return result.stdout;
  const details = `${result.stderr || ""}${result.stdout || ""}`;
  if (/does not exist|exists on disk, but not in|Path .* does not exist/i.test(details)) return null;
  throw new Error(`cannot read ${relative} from ${ref}: ${details.trim()}`);
}

export function assertUniquePlanIds(root, files) {
  const seen = new Map();
  for (const file of files) {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`cannot read plan identity from ${relativeGitPath(root, file)}: ${error.message}`);
    }
    const id = plan?.plan?.id;
    if (!id) continue;
    const previous = seen.get(id);
    if (previous) throw new Error(`plan ID ${id} is reused by ${previous} and ${relativeGitPath(root, file)}; create a new plan ID`);
    seen.set(id, relativeGitPath(root, file));
  }
}

export function assertApprovedPlansImmutable({ root, files, baseRef }) {
  if (!baseRef) return [];
  const checked = [];
  const tree = runGit(root, ["ls-tree", "-r", "--name-only", baseRef, "--", ".github/issue-plans"]);
  if (tree.status === 0) {
    for (const relative of String(tree.stdout || "").split("\n").filter((file) => file.endsWith(".json") && !fs.existsSync(path.join(root, file)))) {
      const previous = previousFile(root, baseRef, relative);
      if (!previous) continue;
      try {
        if (JSON.parse(previous)?.approval?.status === "approved") throw new Error(`approved plan is immutable; deletion of ${relative} requires a new plan disposition`);
      } catch (error) {
        if (/approved plan is immutable/.test(error.message)) throw error;
      }
    }
  }
  for (const file of files) {
    const relative = relativeGitPath(root, file);
    const previous = previousFile(root, baseRef, relative);
    if (previous === null) continue;
    let previousPlan;
    try {
      previousPlan = JSON.parse(previous);
    } catch {
      continue;
    }
    if (previousPlan?.approval?.status === "approved" && previous !== fs.readFileSync(file, "utf8")) {
      throw new Error(`approved plan is immutable; create a new plan instead of changing ${relative}`);
    }
    checked.push(relative);
  }
  return checked;
}

export function validateRepository({
  root = process.cwd(),
  configPath = CONFIG_PATH,
  planPath,
  requireApproval = false,
  baseRef,
} = {}) {
  const repositoryRoot = path.resolve(root);
  const resolvedConfig = path.resolve(repositoryRoot, configPath);
  const config = readConfig(resolvedConfig);
  const callerPath = path.resolve(repositoryRoot, CALLER_WORKFLOW_PATH);
  assertCallerMatchesConfig(fs.readFileSync(callerPath, "utf8"), config);
  const repositoryFiles = findPlanFiles(repositoryRoot, config);
  assertUniquePlanIds(repositoryRoot, repositoryFiles);
  const files = planPath
    ? [path.resolve(repositoryRoot, planPath)]
    : repositoryFiles;
  if (!files.length) throw new Error(`no plan JSON files found under ${config.plans.directory}`);
  // Compare every repository plan against the base commit. A targeted
  // validation still selects one plan for execution, but cannot hide edits
  // to another approved plan in the same change.
  const immutable = assertApprovedPlansImmutable({ root: repositoryRoot, files: repositoryFiles, baseRef });
  const plans = files.map((file) => {
    const relative = relativeGitPath(repositoryRoot, file);
    if (!relative.startsWith(`${config.plans.directory}/`)) throw new Error(`plan must be stored below ${config.plans.directory}`);
    const plan = JSON.parse(fs.readFileSync(file, "utf8"));
    const validation = validatePlan(plan, { sourcePath: file, requireApproval });
    assertPlanMatchesConfig(plan, config);
    return {
      path: relative,
      id: plan.plan.id,
      schemaVersion: plan.schemaVersion,
      status: plan.approval.status,
      digest: validation.digest,
      requirements: plan.requirements?.length || 0,
      tasks: plan.epics.reduce((count, epic) => count + epic.tasks.length, 0),
    };
  });
  return { valid: true, root: repositoryRoot, configPath, config, plans, immutable };
}
