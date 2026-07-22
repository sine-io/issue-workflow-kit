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
