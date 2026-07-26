import path from "node:path";
import fs from "node:fs";

import { install } from "./v2-install.mjs";
import { validateRepository } from "./v2-repository.mjs";
import { runDoctor } from "./v2-doctor.mjs";
import { publishPlan } from "./v2-publish.mjs";
import { reconcileV2 } from "./v2-control.mjs";
import { assertPlanMatchesConfig, readConfig } from "./v2-config.mjs";

export class IwfCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "IwfCliError";
  }
}

const COMMANDS = new Set(["init", "validate", "doctor", "plan publish", "reconcile"]);
const HELP = `Usage: iwf <command> [options]

Commands:
  init          Install the minimal Issue Workflow Kit files
  validate      Validate configuration, contracts, plans, and digests
  doctor        Check local tooling and GitHub repository prerequisites
  plan publish  Seal a draft plan and open its planning pull request
  reconcile     Recover and advance the current managed task

Run iwf <command> with the options documented in README.md.`;
const BOOLEAN_OPTIONS = new Set(["force", "dry-run", "require-approval"]);
const COMMAND_OPTIONS = Object.freeze({
  init: new Set(["target", "ref", "kit-repository", "codex-version", "model", "force", "dry-run"]),
  validate: new Set(["root", "config", "plan", "require-approval", "base-ref"]),
  doctor: new Set(["root", "config", "repo"]),
  "plan publish": new Set(["root", "config", "plan", "repo", "base", "head", "dry-run"]),
  reconcile: new Set(["root", "config", "plan", "repo"]),
});

export function parseIwfArgs(argv) {
  if (!argv.length) throw new IwfCliError("command is required: init, validate, doctor, plan publish, or reconcile");
  if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0])) return { command: "help" };
  let command = argv[0];
  let index = 1;
  if (command === "plan" && argv[1] === "publish") {
    command = "plan publish";
    index = 2;
  }
  if (!COMMANDS.has(command)) throw new IwfCliError(`unknown command: ${command}`);
  const options = { command };
  const seen = new Set();
  while (index < argv.length) {
    const flag = argv[index++];
    if (!flag.startsWith("--")) throw new IwfCliError(`unexpected positional argument: ${flag}`);
    const name = flag.slice(2);
    if (!COMMAND_OPTIONS[command].has(name)) throw new IwfCliError(`unknown argument for ${command}: ${flag}`);
    if (seen.has(name)) throw new IwfCliError(`duplicate argument: ${flag}`);
    seen.add(name);
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (BOOLEAN_OPTIONS.has(name)) options[key] = true;
    else {
      const value = argv[index++];
      if (value === undefined || value.startsWith("--")) throw new IwfCliError(`${flag} requires a value`);
      options[key] = value;
    }
  }
  return options;
}

function requireOptions(options, names) {
  for (const name of names) if (!options[name]) throw new IwfCliError(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required for ${options.command}`);
}

export async function executeIwf(argv, {
  cwd = process.cwd(),
  write = (value) => console.log(value),
  installRepository = install,
  validateTarget = validateRepository,
  doctor = (options, context) => runDoctor({
    root: path.resolve(context.cwd, options.root || "."),
    configPath: options.config || ".github/issue-workflow.yml",
    repository: options.repo,
  }),
  publish = (options, context) => publishPlan({
    root: path.resolve(context.cwd, options.root || "."),
    configPath: options.config || ".github/issue-workflow.yml",
    planPath: options.plan,
    repository: options.repo,
    base: options.base,
    head: options.head,
    dryRun: options.dryRun,
  }),
  reconcile = async (options, context) => {
    const root = path.resolve(context.cwd, options.root || ".");
    if (!options.plan) throw new IwfCliError("--plan is required for reconcile");
    const planPath = path.resolve(root, options.plan);
    const config = readConfig(path.resolve(root, options.config || ".github/issue-workflow.yml"));
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assertPlanMatchesConfig(plan, config);
    const repository = options.repo || `${plan.repository.owner}/${plan.repository.name}`;
    return reconcileV2({ plan, planPath, repository });
  },
} = {}) {
  const options = parseIwfArgs(argv);
  if (options.command === "help") {
    write(HELP);
    return { help: true };
  }
  let result;
  if (options.command === "init") {
    requireOptions(options, ["ref", "codexVersion"]);
    result = installRepository({
      target: path.resolve(cwd, options.target || "."),
      revision: options.ref,
      repository: options.kitRepository,
      cliVersion: options.codexVersion,
      model: options.model,
      force: options.force,
      dryRun: options.dryRun,
    });
  } else if (options.command === "validate") {
    result = validateTarget({
      root: path.resolve(cwd, options.root || "."),
      configPath: options.config || ".github/issue-workflow.yml",
      planPath: options.plan,
      requireApproval: options.requireApproval,
      baseRef: options.baseRef,
    });
  } else if (options.command === "doctor") {
    result = await doctor(options, { cwd });
  } else if (options.command === "plan publish") {
    requireOptions(options, ["plan"]);
    result = await publish(options, { cwd });
  } else {
    result = await reconcile(options, { cwd });
  }
  write(JSON.stringify({ command: options.command, ...result }, null, 2));
  return result;
}
