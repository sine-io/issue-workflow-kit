#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  buildIssueBody,
  flattenIssues,
  labelsForIssue,
  replaceTokens,
  reverseDependencies,
  summarize,
  validateConfig,
} from "./bootstrap-lib.mjs";

const API_VERSION = "2026-03-10";

function parseArgs(argv) {
  const options = { config: "config/project-bootstrap.json", dryRun: false, issuesOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") options.config = argv[++index];
    else if (value === "--repo") options.repo = argv[++index];
    else if (value === "--project-owner") options.projectOwner = argv[++index];
    else if (value === "--output") options.output = argv[++index];
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--issues-only") options.issuesOnly = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runGh(args, { input, allowFailure = false } = {}) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = spawnSync("gh", args, {
      encoding: "utf8",
      env: process.env,
      input: input === undefined ? undefined : String(input),
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status === 0) return result.stdout.trim();
    const message = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    if (/secondary rate|rate limit|abuse|HTTP 429|HTTP 502|HTTP 503/i.test(message) && attempt < 4) {
      console.log(`GitHub API is temporarily unavailable; retrying in ${attempt * 2}s...`);
      sleep(attempt * 2000);
      continue;
    }
    if (allowFailure) return { status: result.status, stdout: result.stdout.trim(), stderr: message };
    throw new Error(`gh ${args.join(" ")} failed:\n${message}`);
  }
}

function runJson(args, options = {}) {
  const output = runGh(args, options);
  if (typeof output !== "string") return output;
  return output ? JSON.parse(output) : {};
}

function api(method, endpoint, body, { allowFailure = false } = {}) {
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
  return runJson(args, { input, allowFailure });
}

function graphql(query, variables) {
  return runJson(["api", "graphql", "--input", "-"], {
    input: JSON.stringify({ query, variables }),
  });
}

function resolveRepository(explicitRepository) {
  const value = explicitRepository || process.env.GITHUB_REPOSITORY || runJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
  if (!/^[^/]+\/[^/]+$/.test(value || "")) throw new Error("Unable to determine repository; pass --repo owner/name");
  const [owner, repo] = value.split("/");
  return { owner, repo, nameWithOwner: value };
}

function readConfig(file, repository, projectOwnerOverride) {
  const absolute = path.resolve(file);
  const config = JSON.parse(fs.readFileSync(absolute, "utf8"));
  const context = { owner: repository.owner, repo: repository.repo };
  config.project.title = replaceTokens(config.project.title, context);
  config.project.owner = projectOwnerOverride || replaceTokens(config.project.owner || repository.owner, context);
  config.project.description = replaceTokens(config.project.description || "", context);
  return config;
}

function ensureLabels(config, repository) {
  console.log(`Creating or updating ${config.labels.length} labels...`);
  for (const label of config.labels) {
    runGh([
      "label", "create", label.name, "--repo", repository.nameWithOwner,
      "--color", label.color, "--description", label.description || "", "--force",
    ]);
  }
}

function listIssues(repository) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const batch = api("GET", `repos/${repository.nameWithOwner}/issues?state=all&per_page=100&page=${page}`);
    all.push(...batch.filter((item) => !item.pull_request));
    if (batch.length < 100) return all;
  }
}

function ensureIssues(config, issues, repository) {
  const existing = listIssues(repository);
  const byTitle = new Map(existing.map((issue) => [issue.title, issue]));
  const refs = new Map();
  for (const issue of issues) {
    const title = `[${issue.id}] ${issue.title}`;
    let ref = byTitle.get(title);
    if (!ref) {
      ref = api("POST", `repos/${repository.nameWithOwner}/issues`, {
        title,
        body: `> Task ID: \`${issue.id}\`\n\nBootstrap is synchronizing this issue.`,
        labels: labelsForIssue(issue),
      });
      console.log(`Created #${ref.number} ${title}`);
      sleep(100);
    } else {
      console.log(`Reusing #${ref.number} ${title}`);
    }
    refs.set(issue.id, ref);
  }

  const reverse = reverseDependencies(issues);
  for (const issue of issues) {
    const ref = refs.get(issue.id);
    api("PATCH", `repos/${repository.nameWithOwner}/issues/${ref.number}`, {
      title: `[${issue.id}] ${issue.title}`,
      body: buildIssueBody(issue, refs, reverse),
      labels: labelsForIssue(issue),
    });
  }
  return refs;
}

function ensureSubIssues(issues, refs, repository) {
  const mutation = `
    mutation($issueId: ID!, $subIssueId: ID!) {
      addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
        issue { id }
        subIssue { id }
      }
    }
  `;
  for (const parent of issues.filter((item) => item.children.length > 0)) {
    const parentRef = refs.get(parent.id);
    const current = api("GET", `repos/${repository.nameWithOwner}/issues/${parentRef.number}/sub_issues?per_page=100`);
    const currentNumbers = new Set(current.map((item) => item.number));
    for (const child of issues.filter((item) => item.parentId === parent.id)) {
      const childRef = refs.get(child.id);
      if (!currentNumbers.has(childRef.number)) {
        graphql(mutation, { issueId: parentRef.node_id, subIssueId: childRef.node_id });
      }
    }
  }
}

function ensureProject(config, repository) {
  console.log(`Creating or updating Project: ${config.project.title}`);
  const owner = config.project.owner;
  const list = runJson(["project", "list", "--owner", owner, "--limit", "100", "--format", "json"]);
  let project = (list.projects || []).find((item) => item.title === config.project.title);
  if (!project) {
    const result = runGh(["project", "create", "--owner", owner, "--title", config.project.title, "--format", "json"], { allowFailure: true });
    if (typeof result !== "string") {
      if (/personal access token|permission|accessible/i.test(result.stderr)) {
        throw new Error("GitHub Project creation requires Projects: Read and write on the Project owner. Configure PROJECT_TOKEN, then rerun; existing Issues will be reused.");
      }
      throw new Error(result.stderr);
    }
    project = JSON.parse(result);
  }

  const number = String(project.number);
  runGh([
    "project", "edit", number, "--owner", owner,
    "--visibility", config.project.visibility,
    "--description", config.project.description,
    "--readme", "Generated from config/project-bootstrap.json. Update the manifest and rerun bootstrap to synchronize GitHub state.",
  ]);
  const link = runGh(["project", "link", number, "--owner", owner, "--repo", repository.repo], { allowFailure: true });
  if (typeof link !== "string" && !/already|linked/i.test(link.stderr)) throw new Error(link.stderr);
  const viewed = runJson(["project", "view", number, "--owner", owner, "--format", "json"]);
  return { ...project, ...viewed, number: Number(number), owner };
}

function ensureProjectFields(config, project) {
  let result = runJson(["project", "field-list", String(project.number), "--owner", project.owner, "--limit", "50", "--format", "json"]);
  let fields = result.fields || [];
  const status = fields.find((field) => field.name === "Status");
  if (!status) throw new Error("Project does not contain the default Status field");
  graphql(`
    mutation($input: UpdateProjectV2FieldInput!) {
      updateProjectV2Field(input: $input) { clientMutationId }
    }
  `, {
    input: { fieldId: status.id, singleSelectOptions: config.project.statusOptions },
  });

  for (const configured of config.project.fields) {
    if (!fields.some((field) => field.name === configured.name)) {
      runGh([
        "project", "field-create", String(project.number), "--owner", project.owner,
        "--name", configured.name, "--data-type", "SINGLE_SELECT",
        "--single-select-options", configured.options.join(","),
      ]);
    }
  }
  result = runJson(["project", "field-list", String(project.number), "--owner", project.owner, "--limit", "50", "--format", "json"]);
  fields = result.fields || [];

  const ownerInfo = api("GET", `users/${project.owner}`);
  const viewEndpoint = ownerInfo.type === "Organization"
    ? `orgs/${project.owner}/projectsV2/${project.number}/views`
    : `users/${ownerInfo.id}/projectsV2/${project.number}/views`;
  const viewsResult = api("GET", viewEndpoint, undefined, { allowFailure: true });
  const views = viewsResult?.value || [];
  if (Array.isArray(views) && !views.some((view) => view.name === "Task Board")) {
    const created = api("POST", viewEndpoint, { name: "Task Board", layout: "board", filter: "is:issue is:open" }, { allowFailure: true });
    if (created?.status !== undefined) console.warn(`Unable to create Board view automatically: ${created.stderr}`);
  }
  return fields;
}

function queryProjectItems(projectId) {
  const result = graphql(`
    query($id: ID!) {
      node(id: $id) {
        ... on ProjectV2 {
          items(first: 100) {
            nodes { id content { ... on Issue { id number url } } }
          }
        }
      }
    }
  `, { id: projectId });
  return result.data.node.items.nodes.filter((item) => item.content?.id);
}

function optionId(field, name) {
  const option = (field.options || []).find((item) => item.name === name);
  if (!option) throw new Error(`Project field ${field.name} does not contain option ${name}`);
  return option.id;
}

function setProjectValue(project, itemId, fieldId, option) {
  graphql(`
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
        value: { singleSelectOptionId: $option }
      }) { projectV2Item { id } }
    }
  `, { projectId: project.id, itemId, fieldId, option });
}

function configureProjectItems(config, project, fields, issues, refs) {
  const addMutation = `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `;
  const items = queryProjectItems(project.id);
  const byContent = new Map(items.map((item) => [item.content.id, item]));
  for (const issue of issues) {
    const ref = refs.get(issue.id);
    if (!byContent.has(ref.node_id)) {
      const result = graphql(addMutation, { projectId: project.id, contentId: ref.node_id });
      byContent.set(ref.node_id, { id: result.data.addProjectV2ItemById.item.id, content: { id: ref.node_id } });
    }
  }

  const refreshed = runJson(["project", "field-list", String(project.number), "--owner", project.owner, "--limit", "50", "--format", "json"]);
  fields = refreshed.fields || fields;
  const status = fields.find((field) => field.name === "Status");
  for (const issue of issues) {
    const ref = refs.get(issue.id);
    const item = byContent.get(ref.node_id);
    setProjectValue(project, item.id, status.id, optionId(status, config.project.initialStatus));
    for (const configured of config.project.fields) {
      const field = fields.find((candidate) => candidate.name === configured.name);
      setProjectValue(project, item.id, field.id, optionId(field, issue[configured.source]));
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repository = resolveRepository(options.repo);
  const config = readConfig(options.config, repository, options.projectOwner);
  const flattened = validateConfig(config, { allowEmpty: options.dryRun });

  if (options.dryRun) {
    console.log(JSON.stringify({ repository: repository.nameWithOwner, ...summarize(config, flattened) }, null, 2));
    if (!flattened.length) console.log("Manifest is valid but contains no issues. Add tasks before bootstrap.");
    return;
  }

  ensureLabels(config, repository);
  const refs = ensureIssues(config, flattened, repository);
  ensureSubIssues(flattened, refs, repository);
  let project = null;
  if (!options.issuesOnly) {
    project = ensureProject(config, repository);
    const fields = ensureProjectFields(config, project);
    configureProjectItems(config, project, fields, flattened, refs);
  }

  const result = {
    repository: repository.nameWithOwner,
    project: project ? { number: project.number, url: project.url } : null,
    issues: flattened.map((issue) => ({
      id: issue.id,
      number: refs.get(issue.id).number,
      url: refs.get(issue.id).html_url,
      parentId: issue.parentId || null,
    })),
  };
  if (options.output) fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...summarize(config, flattened), project: result.project }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
