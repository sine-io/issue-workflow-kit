import { spawnSync } from "node:child_process";
import process from "node:process";

const API_VERSION = "2022-11-28";
const transientPattern = /secondary rate|rate limit|abuse|HTTP 429|HTTP 502|HTTP 503|timed out|ECONNRESET/i;

function blockingSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function httpStatus(message) {
  const match = String(message || "").match(/HTTP\s+(\d{3})/i);
  return match ? Number(match[1]) : null;
}

export class GitHubCommandError extends Error {
  constructor(args, result) {
    const details = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    super(`gh ${args.join(" ")} failed${details ? `:\n${details}` : ""}`);
    this.name = "GitHubCommandError";
    this.args = args;
    this.exitCode = result.status;
    this.httpStatus = httpStatus(details);
  }
}

export class GitHubGraphQLError extends Error {
  constructor(errors) {
    super(`GitHub GraphQL request failed: ${errors.map((error) => error.message || JSON.stringify(error)).join("; ")}`);
    this.name = "GitHubGraphQLError";
    this.errors = errors;
  }
}

export class GitHubAdapter {
  constructor({
    runner = (args, options) => spawnSync("gh", args, options),
    env = process.env,
    sleep = blockingSleep,
    retries = 4,
  } = {}) {
    this.runner = runner;
    // GitHub CLI only consumes GH_TOKEN/GITHUB_TOKEN. Keep the public
    // protocol name IWF_TOKEN while mapping it at the adapter boundary.
    this.env = { ...env };
    if (this.env.IWF_TOKEN) this.env.GH_TOKEN = this.env.IWF_TOKEN;
    this.sleep = sleep;
    this.retries = retries;
  }

  run(args, { input } = {}) {
    let lastResult;
    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      const result = this.runner(args, {
        encoding: "utf8",
        env: this.env,
        input: input === undefined ? undefined : String(input),
        maxBuffer: 20 * 1024 * 1024,
      });
      lastResult = result;
      if (result.error?.code === "ENOENT") throw new Error("GitHub CLI (gh) is not installed or not on PATH");
      if (result.status === 0) return String(result.stdout || "").trim();
      const details = `${result.stderr || ""}\n${result.stdout || ""}`;
      if (transientPattern.test(details) && attempt < this.retries) {
        this.sleep(attempt * 1000);
        continue;
      }
      throw new GitHubCommandError(args, result);
    }
    throw new GitHubCommandError(args, lastResult);
  }

  checkCli() {
    this.run(["--version"]);
  }

  checkAuth() {
    this.run(["auth", "status"]);
  }

  api(method, endpoint, body) {
    const args = [
      "api", endpoint, "--method", method,
      "-H", "Accept: application/vnd.github+json",
      "-H", `X-GitHub-Api-Version: ${API_VERSION}`,
    ];
    let input;
    if (body !== undefined) {
      args.push("--input", "-");
      input = JSON.stringify(body);
    }
    const output = this.run(args, { input });
    try {
      return output ? JSON.parse(output) : {};
    } catch (error) {
      throw new Error(`GitHub REST API returned invalid JSON for ${method} ${endpoint}: ${error.message}`);
    }
  }

  getRepository(repository) {
    return this.api("GET", `repos/${repository}`);
  }

  getAuthenticatedUser() {
    return this.api("GET", "user");
  }

  getBranch(repository, branch) {
    return this.api("GET", `repos/${repository}/branches/${encodeURIComponent(branch)}`);
  }

  getBranchProtection(repository, branch) {
    return this.api("GET", `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`);
  }

  getActionsWorkflowPermissions(repository) {
    return this.api("GET", `repos/${repository}/actions/permissions/workflow`);
  }

  async listActionsSecrets(repository) {
    const names = [];
    for (let page = 1; ; page += 1) {
      const result = this.api("GET", `repos/${repository}/actions/secrets?per_page=100&page=${page}`);
      const batch = result.secrets || [];
      names.push(...batch);
      if (batch.length < 100) return names;
    }
  }

  async listPullRequests(repository, { state = "open", head, base } = {}) {
    const pulls = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({ state, per_page: "100", page: String(page) });
      if (head) query.set("head", head);
      if (base) query.set("base", base);
      const batch = this.api("GET", `repos/${repository}/pulls?${query}`);
      pulls.push(...batch);
      if (batch.length < 100) return pulls;
    }
  }

  createPullRequest(repository, pullRequest) {
    return this.api("POST", `repos/${repository}/pulls`, pullRequest);
  }

  updatePullRequest(repository, number, pullRequest) {
    return this.api("PATCH", `repos/${repository}/pulls/${encodeURIComponent(number)}`, pullRequest);
  }

  mergePullRequest(repository, number, merge) {
    return this.api("PUT", `repos/${repository}/pulls/${encodeURIComponent(number)}/merge`, merge);
  }

  getGitReference(repository, ref) {
    return this.api("GET", `repos/${repository}/git/ref/${encodeURIComponent(ref)}`);
  }

  createGitReference(repository, ref, sha) {
    return this.api("POST", `repos/${repository}/git/refs`, { ref, sha });
  }

  dispatchWorkflow(repository, workflow, { ref, inputs = {} } = {}) {
    return this.api("POST", `repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs });
  }

  createPullRequestReview(repository, number, review) {
    return this.api("POST", `repos/${repository}/pulls/${encodeURIComponent(number)}/reviews`, review);
  }

  getCommit(repository, revision) {
    return this.api("GET", `repos/${repository}/commits/${encodeURIComponent(revision)}`);
  }

  getAssignee(repository, login) {
    return this.api("GET", `repos/${repository}/assignees/${encodeURIComponent(login)}`);
  }

  graphql(query, variables = {}) {
    const output = this.run(["api", "graphql", "--input", "-"], {
      input: JSON.stringify({ query, variables }),
    });
    let result;
    try {
      result = JSON.parse(output);
    } catch (error) {
      throw new Error(`GitHub GraphQL API returned invalid JSON: ${error.message}`);
    }
    if (result.errors?.length) throw new GitHubGraphQLError(result.errors);
    if (!result.data) throw new GitHubGraphQLError([{ message: "GraphQL response did not contain data" }]);
    return result.data;
  }

  async listSubIssues(issueNodeId) {
    return this.listIssueConnection(issueNodeId, "subIssues");
  }

  async listBlockedBy(issueNodeId) {
    return this.listIssueConnection(issueNodeId, "blockedBy");
  }

  async listIssueConnection(issueNodeId, field) {
    if (!["subIssues", "blockedBy"].includes(field)) throw new Error(`Unsupported Issue connection ${field}`);
    const nodes = [];
    let after = null;
    do {
      const query = `query($id: ID!, $after: String) { node(id: $id) { ... on Issue { ${field}(first: 100, after: $after) { nodes { id number url } pageInfo { hasNextPage endCursor } } } } }`;
      const connection = this.graphql(query, { id: issueNodeId, after }).node?.[field];
      if (!connection) throw new GitHubGraphQLError([{ message: `Issue ${issueNodeId} has no ${field} connection` }]);
      nodes.push(...connection.nodes);
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
    return nodes;
  }

  addSubIssue(issueNodeId, subIssueNodeId) {
    return this.graphql(
      "mutation($issueId: ID!, $subIssueId: ID!) { addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId, replaceParent: false }) { issue { id } subIssue { id } } }",
      { issueId: issueNodeId, subIssueId: subIssueNodeId },
    );
  }

  removeSubIssue(issueNodeId, subIssueNodeId) {
    return this.graphql(
      "mutation($issueId: ID!, $subIssueId: ID!) { removeSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) { issue { id } subIssue { id } } }",
      { issueId: issueNodeId, subIssueId: subIssueNodeId },
    );
  }

  addBlockedBy(issueNodeId, blockingIssueNodeId) {
    return this.graphql(
      "mutation($issueId: ID!, $blockingIssueId: ID!) { addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { id } blockingIssue { id } } }",
      { issueId: issueNodeId, blockingIssueId: blockingIssueNodeId },
    );
  }

  removeBlockedBy(issueNodeId, blockingIssueNodeId) {
    return this.graphql(
      "mutation($issueId: ID!, $blockingIssueId: ID!) { removeBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { id } blockingIssue { id } } }",
      { issueId: issueNodeId, blockingIssueId: blockingIssueNodeId },
    );
  }

  async listLabels(repository) {
    const labels = [];
    for (let page = 1; ; page += 1) {
      const batch = this.api("GET", `repos/${repository}/labels?per_page=100&page=${page}`);
      labels.push(...batch);
      if (batch.length < 100) return labels;
    }
  }

  async createLabel(repository, label) {
    return this.api("POST", `repos/${repository}/labels`, label);
  }

  async updateLabel(repository, currentName, label) {
    return this.api("PATCH", `repos/${repository}/labels/${encodeURIComponent(currentName)}`, {
      new_name: label.name,
      color: label.color,
      description: label.description,
    });
  }

  async listIssues(repository) {
    const issues = [];
    for (let page = 1; ; page += 1) {
      const batch = this.api("GET", `repos/${repository}/issues?state=all&per_page=100&page=${page}`);
      issues.push(...batch.filter((issue) => !issue.pull_request));
      if (batch.length < 100) return issues;
    }
  }

  async createIssue(repository, issue) {
    return this.api("POST", `repos/${repository}/issues`, issue);
  }

  async updateIssue(repository, number, issue) {
    return this.api("PATCH", `repos/${repository}/issues/${number}`, issue);
  }

  getIssue(repository, number) {
    return this.api("GET", `repos/${repository}/issues/${encodeURIComponent(number)}`);
  }

  async listIssueComments(repository, number) {
    const comments = [];
    for (let page = 1; ; page += 1) {
      const batch = this.api("GET", `repos/${repository}/issues/${encodeURIComponent(number)}/comments?per_page=100&page=${page}`);
      comments.push(...batch);
      if (batch.length < 100) return comments;
    }
  }

  listComments(repository, number) {
    return this.listIssueComments(repository, number);
  }

  createIssueComment(repository, number, body) {
    return this.api("POST", `repos/${repository}/issues/${encodeURIComponent(number)}/comments`, { body });
  }

  createComment(repository, number, body) {
    return this.createIssueComment(repository, number, body);
  }

  updateIssueComment(repository, commentId, body) {
    return this.api("PATCH", `repos/${repository}/issues/comments/${encodeURIComponent(commentId)}`, { body });
  }

  updateComment(repository, commentId, body) {
    return this.updateIssueComment(repository, commentId, body);
  }

  async listIssueTimeline(repository, number) {
    const events = [];
    for (let page = 1; ; page += 1) {
      const batch = this.api("GET", `repos/${repository}/issues/${encodeURIComponent(number)}/timeline?per_page=100&page=${page}`);
      events.push(...batch);
      if (batch.length < 100) return events;
    }
  }

  async listPullRequestClosingIssues(pullRequestNodeId) {
    const issues = [];
    let after = null;
    do {
      const query = "query($id: ID!, $after: String) { node(id: $id) { ... on PullRequest { closingIssuesReferences(first: 100, after: $after) { nodes { id number url repository { nameWithOwner } } pageInfo { hasNextPage endCursor } } } } }";
      const connection = this.graphql(query, { id: pullRequestNodeId, after }).node?.closingIssuesReferences;
      if (!connection) throw new GitHubGraphQLError([{ message: `Pull request ${pullRequestNodeId} has no closingIssuesReferences connection` }]);
      issues.push(...connection.nodes);
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
    return issues;
  }

  getPullRequest(repository, number) {
    return this.api("GET", `repos/${repository}/pulls/${encodeURIComponent(number)}`);
  }

  getPR(repository, number) {
    return this.getPullRequest(repository, number);
  }

  async listPullRequestFiles(repository, number) {
    const files = [];
    for (let page = 1; ; page += 1) {
      const batch = this.api("GET", `repos/${repository}/pulls/${encodeURIComponent(number)}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100) return files;
    }
  }

  listPRFiles(repository, number) {
    return this.listPullRequestFiles(repository, number);
  }

  async listCheckRuns(repository, ref) {
    const runs = [];
    for (let page = 1; ; page += 1) {
      const result = this.api("GET", `repos/${repository}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100&page=${page}`);
      const batch = result.check_runs || [];
      runs.push(...batch);
      if (batch.length < 100) return runs;
    }
  }

  async listCommitStatuses(repository, ref) {
    const statuses = [];
    for (let page = 1; ; page += 1) {
      const batch = this.api("GET", `repos/${repository}/commits/${encodeURIComponent(ref)}/statuses?per_page=100&page=${page}`);
      statuses.push(...batch);
      if (batch.length < 100) return statuses;
    }
  }

  async listCommitChecks(repository, ref) {
    const [checkRuns, statuses] = await Promise.all([
      this.listCheckRuns(repository, ref),
      this.listCommitStatuses(repository, ref),
    ]);
    return normalizeCommitChecks(checkRuns, statuses);
  }

  getChecks(repository, ref) {
    return this.listCommitChecks(repository, ref);
  }
}

function checkRunState(run) {
  if (run.status !== "completed") return "pending";
  return run.conclusion === "success" ? "success" : "failure";
}

function commitStatusState(status) {
  if (status.state === "success") return "success";
  if (status.state === "pending") return "pending";
  return "failure";
}

export function normalizeCommitChecks(checkRuns = [], statuses = []) {
  const normalized = new Map();
  for (const status of statuses) {
    const name = status.context;
    if (!name || normalized.has(name)) continue;
    normalized.set(name, {
      name,
      state: commitStatusState(status),
      source: "commit-status",
      detailsUrl: status.target_url || null,
    });
  }
  for (const run of checkRuns) {
    const name = run.name;
    if (!name || normalized.get(name)?.source.includes("check-run")) continue;
    const candidate = {
      name,
      state: checkRunState(run),
      source: "check-run",
      detailsUrl: run.details_url || run.html_url || null,
    };
    const existing = normalized.get(name);
    if (!existing) normalized.set(name, candidate);
    else {
      const rank = { success: 0, pending: 1, failure: 2 };
      normalized.set(name, {
        ...candidate,
        state: rank[existing.state] > rank[candidate.state] ? existing.state : candidate.state,
        source: "check-run+commit-status",
      });
    }
  }
  return [...normalized.values()].sort((left, right) => left.name.localeCompare(right.name));
}
