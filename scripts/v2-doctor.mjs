import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { GitHubAdapter } from "./github-adapter.mjs";
import { CALLER_WORKFLOW_PATH, CONFIG_PATH, assertCallerMatchesConfig, readConfig } from "./v2-config.mjs";

function commandResult(command, args, cwd, runner) {
  return runner(command, args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
}

function repositoryFromRemote(root, runner) {
  const result = commandResult("git", ["remote", "get-url", "origin"], root, runner);
  if (result.status !== 0) return null;
  const remote = String(result.stdout || "").trim();
  const match = remote.match(/(?:github\.com[/:])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function pass(id, detail) {
  return { id, status: "pass", detail };
}

function fail(id, detail) {
  return { id, status: "fail", detail };
}

function versionNumber(output) {
  return String(output || "").match(/\b([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] || null;
}

async function checked(checks, id, action, success) {
  try {
    const value = await action();
    checks.push(pass(id, success(value)));
    return value;
  } catch (error) {
    checks.push(fail(id, error.message));
    return null;
  }
}

function protectionContexts(protection) {
  const status = protection?.required_status_checks;
  return new Set([
    ...(status?.contexts || []),
    ...(status?.checks || []).map((check) => check.context),
  ].filter(Boolean));
}

export async function runDoctor({
  root = process.cwd(),
  configPath = CONFIG_PATH,
  repository,
  adapter = new GitHubAdapter({ retries: 2 }),
  env = process.env,
  runner = spawnSync,
} = {}) {
  const target = path.resolve(root);
  const config = readConfig(path.resolve(target, configPath));
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(nodeMajor >= 20 ? pass("node", `Node.js ${process.versions.node}`) : fail("node", "Node.js 20 or newer is required"));

  const git = commandResult("git", ["--version"], target, runner);
  checks.push(git.status === 0 ? pass("git", String(git.stdout).trim()) : fail("git", "git is not available"));
  const gh = commandResult("gh", ["--version"], target, runner);
  checks.push(gh.status === 0 ? pass("github-cli", String(gh.stdout).split("\n")[0]) : fail("github-cli", "gh is not available"));
  const codex = commandResult("codex", ["--version"], target, runner);
  const actualCodex = versionNumber(`${codex.stdout || ""}\n${codex.stderr || ""}`);
  checks.push(codex.status === 0 && actualCodex === config.runner.cliVersion
    ? pass("codex-cli", `Codex CLI ${actualCodex}`)
    : fail("codex-cli", `expected Codex CLI ${config.runner.cliVersion}; found ${actualCodex || "unavailable"}`));

  const caller = path.join(target, CALLER_WORKFLOW_PATH);
  const expectedUse = `${config.kit.repository}/${config.kit.reusableWorkflow}@${config.kit.revision}`;
  const callerSource = fs.existsSync(caller) ? fs.readFileSync(caller, "utf8") : "";
  let callerPinned = false;
  try {
    assertCallerMatchesConfig(callerSource, config);
    callerPinned = true;
  } catch {
    callerPinned = false;
  }
  checks.push(callerPinned
    ? pass("workflow-pin", expectedUse)
    : fail("workflow-pin", `caller must use ${expectedUse}`));
  checks.push(env.IWF_TOKEN ? pass("iwf-token-env", "IWF_TOKEN is available") : fail("iwf-token-env", "IWF_TOKEN is not available"));
  checks.push(env.CODEX_API_KEY ? pass("codex-key-env", "CODEX_API_KEY is available") : fail("codex-key-env", "CODEX_API_KEY is not available"));

  const repo = repository || repositoryFromRemote(target, runner);
  if (!repo) {
    checks.push(fail("repository", "--repo or a GitHub origin remote is required"));
    return { healthy: false, repository: null, checks };
  }
  const info = await checked(checks, "repository", () => adapter.getRepository(repo), (value) => value.full_name || repo);
  if (info) {
    const writable = info.permissions?.admin === true || info.permissions?.maintain === true || info.permissions?.push === true;
    checks.push(writable ? pass("github-write", "automation identity can write the repository") : fail("github-write", "automation identity lacks repository write permission"));
    checks.push(info.has_issues !== false ? pass("issues", "Issues are enabled") : fail("issues", "Issues are disabled"));
    checks.push(info.allow_auto_merge === true ? pass("auto-merge", "auto-merge is enabled") : fail("auto-merge", "repository auto-merge is disabled"));
  }

  const secretRecords = await checked(checks, "actions-secrets-api", () => adapter.listActionsSecrets(repo), (value) => `read ${value.length} repository secret names`);
  if (secretRecords) {
    const names = new Set(secretRecords.map((secret) => secret.name));
    for (const name of [config.secrets.githubToken, config.secrets.codexApiKey]) {
      checks.push(names.has(name) || env[name]
        ? pass(`secret-${name.toLowerCase()}`, `${name} is configured`)
        : fail(`secret-${name.toLowerCase()}`, `${name} is not configured as a repository secret or current environment value`));
    }
  }

  if (info) {
    const branch = info.default_branch;
    await checked(checks, "default-branch", () => adapter.getBranch(repo, branch), () => branch);
    const protection = await checked(checks, "branch-protection-api", () => adapter.getBranchProtection(repo, branch), () => `${branch} protection is readable`);
    if (protection) {
      const contexts = protectionContexts(protection);
      const missing = config.orchestration.requiredChecks.filter((name) => !contexts.has(name));
      checks.push(missing.length
        ? fail("required-checks", `branch protection is missing: ${missing.join(", ")}`)
        : pass("required-checks", "all configured checks are protected"));
      checks.push(protection.allow_force_pushes?.enabled === true
        ? fail("force-push", "force pushes are allowed on the default branch")
        : pass("force-push", "force pushes are disabled"));
    }
    await checked(checks, "workflow-permissions", () => adapter.getActionsWorkflowPermissions(repo), (value) => `default permission: ${value.default_workflow_permissions || "unknown"}`);
  }

  return { healthy: checks.every((check) => check.status === "pass"), repository: repo, checks };
}
