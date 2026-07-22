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
    this.env = env;
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

  getCommit(repository, revision) {
    return this.api("GET", `repos/${repository}/commits/${encodeURIComponent(revision)}`);
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
}
