import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  CALLER_WORKFLOW_PATH,
  CONFIG_PATH,
  PLAN_DIRECTORY,
  SKILL_DIRECTORY,
  callerWorkflow,
  configText,
  defaultConfig,
  validateConfig,
} from "./v2-config.mjs";

const kitRoot = path.resolve(new URL("..", import.meta.url).pathname);

function readKitFile(relative) {
  return fs.readFileSync(path.join(kitRoot, relative), "utf8");
}

function installationFiles(config, defaultBranch) {
  return new Map([
    [CONFIG_PATH, configText(config)],
    [CALLER_WORKFLOW_PATH, callerWorkflow(config, { defaultBranch })],
    [`${SKILL_DIRECTORY}/SKILL.md`, readKitFile(".codex/skills/iwf-plan/SKILL.md")],
    [`${SKILL_DIRECTORY}/agents/openai.yaml`, readKitFile(".codex/skills/iwf-plan/agents/openai.yaml")],
    [`${PLAN_DIRECTORY}/.gitkeep`, ""],
  ]);
}

function assertGitRepository(root) {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`target directory does not exist: ${root}`);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  const topLevel = result.status === 0 ? String(result.stdout || "").trim() : "";
  if (!topLevel || fs.realpathSync(topLevel) !== fs.realpathSync(root)) throw new Error(`target is not a Git repository root: ${root}`);
}

function currentBranch(root) {
  const result = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 && String(result.stdout || "").trim() ? String(result.stdout).trim() : "main";
}

function symlinkComponent(root, relative) {
  let current = root;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return current;
  }
  return null;
}

export function install({
  target = process.cwd(),
  revision,
  repository,
  cliVersion,
  model,
  force = false,
  dryRun = false,
} = {}) {
  const root = path.resolve(target);
  assertGitRepository(root);
  const config = validateConfig(defaultConfig({ revision, repository, cliVersion, model }));
  const files = installationFiles(config, currentBranch(root));
  const operations = [];
  const conflicts = [];
  for (const [relative, content] of files) {
    const destination = path.join(root, relative);
    const symlink = symlinkComponent(root, relative);
    if (symlink) {
      operations.push({ path: relative, action: "symlink" });
      conflicts.push(`${relative} (symbolic link: ${path.relative(root, symlink)})`);
    } else if (!fs.existsSync(destination)) operations.push({ path: relative, action: "create" });
    else if (fs.readFileSync(destination, "utf8") === content) operations.push({ path: relative, action: "unchanged" });
    else {
      operations.push({ path: relative, action: force ? "replace" : "conflict" });
      conflicts.push(relative);
    }
  }
  if (operations.some(({ action }) => action === "symlink")) {
    throw new Error(`installation refuses symbolic-link destinations: ${conflicts.filter((item) => item.includes("(symbolic link:")).join(", ")}`);
  }
  if (conflicts.length && !force) {
    throw new Error(`installation would overwrite existing files: ${conflicts.join(", ")}`);
  }
  if (!dryRun) {
    for (const [relative, content] of files) {
      const operation = operations.find((item) => item.path === relative);
      if (operation.action === "unchanged") continue;
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content, { encoding: "utf8", mode: relative.endsWith(".mjs") ? 0o755 : 0o644 });
    }
  }
  return { target: root, dryRun, config, operations };
}
