import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { GitHubAdapter } from "./github-adapter.mjs";
import { CONFIG_PATH, assertPlanMatchesConfig, findPlanFiles, readConfig } from "./v2-config.mjs";
import { readV2Plan, v2PlanDigest, validateV2Plan } from "./v2-plan.mjs";
import { assertUniquePlanIds } from "./v2-repository.mjs";

function git(root, args, runner) {
  const result = runner("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout || "").trim();
}

function gitAttempt(root, args, runner) {
  return runner("git", args, { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

function gitRelative(root, file) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (!relative || relative.startsWith("../")) throw new Error(`${file} is outside the repository`);
  const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error(`${file} symbolic link escapes the repository`);
  return relative;
}

function changedPaths(root, runner) {
  const output = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], runner);
  if (!output) return [];
  return output.split("\n").map((line) => {
    const value = line.slice(3);
    const renamed = value.includes(" -> ") ? value.split(" -> ").at(-1) : value;
    return renamed.replace(/^"|"$/g, "");
  });
}

function assertOnlyPlanChanges(root, planFile, contractFile, runner) {
  const allowed = new Set([gitRelative(root, planFile), gitRelative(root, contractFile)]);
  const unexpected = changedPaths(root, runner).filter((file) => !allowed.has(file));
  if (unexpected.length) throw new Error(`plan publish requires a clean worktree outside plan artifacts: ${unexpected.join(", ")}`);
}

function planBranch(planId) {
  return `iwf/plan-${planId.toLowerCase()}`;
}

function marker(planId, digest) {
  const encoded = JSON.stringify({ digest, planId }).replaceAll("--", "\\u002d\\u002d");
  return `<!-- iwf-plan-pr:v2 ${encoded} -->`;
}

function pullRequestBody(plan, digest) {
  const requirements = plan.requirements.map((requirement) => `- \`${requirement.id}\` ${requirement.title}`).join("\n");
  const tasks = plan.epics.flatMap((epic) => epic.tasks).map((task) => `- \`${task.id}\` ${task.title}`).join("\n");
  return `${marker(plan.plan.id, digest)}\n\n## Plan digest\n\n\`${digest}\`\n\n## Requirements\n\n${requirements}\n\n## Serial tasks\n\n${tasks}\n\nMerging this planning PR is the sole human business approval. Implementation Issues and PRs are created only after this PR is merged.\n`;
}

function commitPlan(root, plan, planFile, contractFile, branch, runner) {
  const current = git(root, ["branch", "--show-current"], runner);
  const branchExists = gitAttempt(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], runner).status === 0;
  if (current !== branch) {
    if (branchExists) throw new Error(`local branch ${branch} already exists; switch to it and reconcile before publishing`);
    git(root, ["switch", "-c", branch, plan.plan.baseRevision], runner);
  }
  git(root, ["add", "--", gitRelative(root, planFile), gitRelative(root, contractFile)], runner);
  const staged = git(root, ["diff", "--cached", "--name-only"], runner).split("\n").filter(Boolean);
  const expected = new Set([gitRelative(root, planFile), gitRelative(root, contractFile)]);
  if (staged.some((file) => !expected.has(file))) throw new Error("planning commit contains unexpected files");
  if (staged.length) git(root, ["commit", "-m", `plan: publish ${plan.plan.id}`], runner);
  else if (!branchExists) throw new Error("planning commit contains no plan changes");
  git(root, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], runner);
  return git(root, ["rev-parse", "HEAD"], runner);
}

export async function publishPlan({
  root = process.cwd(),
  configPath = CONFIG_PATH,
  planPath,
  repository,
  base,
  head,
  dryRun = false,
  adapter = new GitHubAdapter({ retries: 2 }),
  runner = spawnSync,
  clock = () => new Date(),
} = {}) {
  const target = path.resolve(root);
  const file = path.resolve(target, planPath);
  const config = readConfig(path.resolve(target, configPath));
  assertUniquePlanIds(target, findPlanFiles(target, config));
  const relativePlan = gitRelative(target, file);
  if (!relativePlan.startsWith(`${config.plans.directory}/`)) throw new Error(`plan must be stored below ${config.plans.directory}`);
  const plan = readV2Plan(file);
  const initial = validateV2Plan(plan, { sourcePath: file });
  assertPlanMatchesConfig(plan, config);
  const repo = repository || `${plan.repository.owner}/${plan.repository.name}`;
  if (repo.toLowerCase() !== `${plan.repository.owner}/${plan.repository.name}`.toLowerCase()) {
    throw new Error("--repo does not match the plan repository");
  }
  const contractFile = initial.contractPath;
  assertOnlyPlanChanges(target, file, contractFile, runner);

  const repositoryInfo = await adapter.getRepository(repo);
  const defaultBranch = base || repositoryInfo.default_branch;
  if (defaultBranch !== plan.repository.defaultBranch) throw new Error("default branch differs from the approved plan input");
  const [baseCommit, plannedCommit, user] = await Promise.all([
    adapter.getBranch(repo, defaultBranch),
    adapter.getCommit(repo, plan.plan.baseRevision),
    adapter.getAuthenticatedUser(),
  ]);
  const currentBaseSha = baseCommit?.commit?.sha || baseCommit?.sha;
  const resolvedPlanSha = plannedCommit?.sha;
  if (currentBaseSha !== plan.plan.baseRevision || resolvedPlanSha !== plan.plan.baseRevision) {
    throw new Error(`plan baseRevision ${plan.plan.baseRevision} is not the current ${defaultBranch} commit`);
  }

  const digest = v2PlanDigest(plan);
  const sealed = structuredClone(plan);
  if (sealed.approval.status === "draft") {
    if (!user?.login) throw new Error("GitHub did not return the authenticated planning publisher");
    sealed.approval = {
      status: "approved",
      digest,
      approvedAt: clock().toISOString(),
      approvedBy: user.login,
    };
  }
  validateV2Plan(sealed, { sourcePath: file, requireApproval: true });
  const branch = head || planBranch(plan.plan.id);
  const body = pullRequestBody(sealed, digest);
  if (dryRun) {
    return {
      dryRun: true,
      repository: repo,
      planId: plan.plan.id,
      digest,
      base: defaultBranch,
      head: branch,
      files: [gitRelative(target, file), gitRelative(target, contractFile)],
    };
  }

  const owner = repo.split("/")[0];
  const openPlanning = await adapter.listPullRequests(repo, { state: "open", base: defaultBranch });
  const competing = openPlanning.filter((pull) => String(pull.body || "").includes("<!-- iwf-plan-pr:v2 ")
    && !String(pull.body || "").includes(marker(plan.plan.id, digest)));
  if (competing.length) throw new Error(`another planning PR is already open: #${competing[0].number}`);
  const existing = await adapter.listPullRequests(repo, { state: "all", head: `${owner}:${branch}`, base: defaultBranch });
  if (existing.length > 1) throw new Error(`multiple planning PRs use branch ${branch}`);
  if (existing.length) {
    if (!String(existing[0].body || "").includes(marker(plan.plan.id, digest))) {
      throw new Error(`existing pull request #${existing[0].number} does not match plan ${plan.plan.id} and digest`);
    }
    return {
      dryRun: false,
      repository: repo,
      planId: sealed.plan.id,
      digest,
      base: defaultBranch,
      head: branch,
      commitSha: existing[0].head?.sha || null,
      pullRequest: {
        number: existing[0].number,
        url: existing[0].html_url || existing[0].url,
        state: existing[0].state,
      },
    };
  }
  if (plan.approval.status === "draft") fs.writeFileSync(file, `${JSON.stringify(sealed, null, 2)}\n`, "utf8");
  let commitSha;
  commitSha = commitPlan(target, sealed, file, contractFile, branch, runner);
  const pullRequest = await adapter.createPullRequest(repo, {
    title: `[Plan] ${sealed.plan.title}`,
    body,
    base: defaultBranch,
    head: branch,
    maintainer_can_modify: false,
  });
  return {
    dryRun: false,
    repository: repo,
    planId: sealed.plan.id,
    digest,
    base: defaultBranch,
    head: branch,
    commitSha: commitSha || pullRequest.head?.sha || null,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.html_url || pullRequest.url,
      state: pullRequest.state,
    },
  };
}
