import assert from "node:assert/strict";
import test from "node:test";

import { GitHubAdapter, GitHubCommandError, normalizeCommitChecks } from "../scripts/github-adapter.mjs";

const repository = "example/repository";

function pageOf(endpoint) {
  return Number(new URL(`https://api.test/${endpoint}`).searchParams.get("page"));
}

test("runtime adapter paginates comments and PR files", async () => {
  const requests = [];
  const runner = (args) => {
    const endpoint = args[1];
    requests.push(endpoint);
    const count = pageOf(endpoint) === 1 ? 100 : 1;
    return {
      status: 0,
      stdout: JSON.stringify(Array.from({ length: count }, (_, index) => ({ id: `${endpoint}-${index}` }))),
      stderr: "",
    };
  };
  const adapter = new GitHubAdapter({ runner });
  assert.equal((await adapter.listIssueComments(repository, 12)).length, 101);
  assert.equal((await adapter.listPullRequestFiles(repository, 34)).length, 101);
  assert.equal(requests.length, 4);
});

test("runtime adapter creates and updates a single managed comment", async () => {
  const requests = [];
  const runner = (args, options) => {
    requests.push({ args, input: options.input && JSON.parse(options.input) });
    return { status: 0, stdout: JSON.stringify({ id: 99, body: requests.at(-1).input.body }), stderr: "" };
  };
  const adapter = new GitHubAdapter({ runner });
  await adapter.createIssueComment(repository, 12, "created");
  await adapter.updateIssueComment(repository, 99, "updated");
  assert.match(requests[0].args[1], /issues\/12\/comments$/);
  assert.equal(requests[0].input.body, "created");
  assert.match(requests[1].args[1], /issues\/comments\/99$/);
  assert.equal(requests[1].input.body, "updated");
});

test("check runs and commit statuses normalize into one authoritative state per name", () => {
  const checks = normalizeCommitChecks([
    { name: "test", status: "completed", conclusion: "success", details_url: "https://example.test/checks/1" },
    { name: "lint", status: "in_progress", conclusion: null },
  ], [
    { context: "test", state: "failure", target_url: "https://example.test/status/1" },
    { context: "legacy", state: "error" },
  ]);
  assert.deepEqual(checks, [
    { name: "legacy", state: "failure", source: "commit-status", detailsUrl: null },
    { name: "lint", state: "pending", source: "check-run", detailsUrl: null },
    { name: "test", state: "failure", source: "check-run+commit-status", detailsUrl: "https://example.test/checks/1" },
  ]);
});

test("runtime adapter surfaces REST errors without issuing a follow-up request", async () => {
  let calls = 0;
  const adapter = new GitHubAdapter({
    retries: 1,
    runner: () => {
      calls += 1;
      return { status: 1, stdout: "", stderr: "HTTP 403 permission denied" };
    },
  });
  await assert.rejects(() => adapter.listIssueComments(repository, 12), GitHubCommandError);
  assert.equal(calls, 1);
});

test("runtime adapter paginates authoritative PR closing Issue references", async () => {
  const runner = (_args, options) => {
    const request = JSON.parse(options.input);
    const first = request.variables.after === null;
    return {
      status: 0,
      stdout: JSON.stringify({ data: { node: { closingIssuesReferences: {
        nodes: [{ id: first ? "issue-1" : "issue-2", number: first ? 1 : 2, url: "", repository: { nameWithOwner: repository } }],
        pageInfo: { hasNextPage: first, endCursor: first ? "next" : null },
      } } } }),
      stderr: "",
    };
  };
  const adapter = new GitHubAdapter({ runner });
  const issues = await adapter.listPullRequestClosingIssues("pr-node");
  assert.deepEqual(issues.map((issue) => issue.number), [1, 2]);
});

test("runtime adapter maps the dedicated IWF identity to GitHub CLI authentication", () => {
  let childEnvironment;
  const adapter = new GitHubAdapter({
    env: { PATH: "/bin", IWF_TOKEN: "dedicated-token", GH_TOKEN: "unrelated-token" },
    runner: (_args, options) => {
      childEnvironment = options.env;
      return { status: 0, stdout: "gh version 2.0.0", stderr: "" };
    },
  });
  adapter.checkCli();
  assert.equal(childEnvironment.GH_TOKEN, "dedicated-token");
  assert.equal(childEnvironment.IWF_TOKEN, "dedicated-token");
});
