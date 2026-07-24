---
name: iwf-plan
description: Create or revise Issue Workflow Kit v2 behavior contracts and machine-validated plans. Use when a request must be clarified into stable REQ-NNN requirements, atomic one-Issue/one-PR tasks, acceptance evidence, allowed paths, dependencies, failure behavior, or a planning PR before automated implementation starts.
---

# IWF Plan

Produce two synchronized artifacts: a user-readable `behavior-contract.md` and a strict `plan.json`. Planning is read-only except for these artifacts and their planning PR.

## Clarify one decision at a time

1. Read repository instructions, current code, tests, default branch, and current base commit.
2. State the observed problem and the intended user outcome in plain language.
3. Ask one focused question. Wait for its answer before asking the next question.
4. Resolve terminology, actors, ownership, system boundaries, normal behavior, exceptions, external side effects, security or data constraints, and unacceptable behavior.
5. Turn vague adjectives into observable examples or thresholds.
6. Stop questioning only when every decision that could change public behavior, scope, dependencies, allowed paths, or acceptance has an explicit answer or labeled assumption.

Do not invent missing product decisions. Do not begin implementation or create task Issues during planning.

## Write the behavior contract

Create `.github/issue-plans/<plan-id>/behavior-contract.md`. Give every requirement a permanent sequential ID and this exact section shape:

```markdown
# Behavior Contract: <literal outcome>

## REQ-001: <requirement title>

### Behavior
<observable behavior>

### Boundaries
- <included boundary or invariant>

### Exceptions
- <failure or exceptional behavior>

### Unacceptable behavior
- <behavior the implementation must never exhibit>
```

Keep requirement titles and the exact Behavior, Boundaries, Exceptions, and Unacceptable behavior content synchronized with the corresponding machine-plan fields; preserve list order. Never recycle an ID for changed semantics; supersede the plan instead.

## Build the machine plan

Create `.github/issue-plans/<plan-id>/plan.json` with `schemaVersion: "2.0"` and `$schema` resolving to the kit's `iwf-plan.v2.schema.json`. Read `.github/issue-workflow.yml` and pin these inputs into the plan:

- kit repository, exact GitHub tag, and reusable workflow path;
- target owner, repository, and default branch;
- full base commit SHA;
- behavior-contract path and SHA-256;
- Codex CLI version, model, prompt revision, and this skill revision.

Mirror every contract requirement in `requirements`. Give requirement acceptance items IDs such as `REQ-001-AC01`.

Split work into atomic tasks. Each task must have one observable outcome, one Issue, one PR, explicit `allowedPaths`, exclusions, requirement IDs, dependencies, acceptance criteria, finite verification commands, timeout, and required checks. Link every task acceptance item to one `requirementId`; link every verification item to one or more `requirementIds`. Use exact requirement acceptance statements in at least one task so traceability is mechanical.

Plan behavior test-first where the repository has a test harness: name the
example that must fail before implementation, include its test path in
`allowedPaths`, and use the exact focused test command as a verification step.
Do not substitute a broad final test run for a requirement-specific regression
example; keep the repository-wide required check as an additional gate.

Order all implementation tasks serially, even when they appear independent. A task may depend only on earlier task IDs. Set `maxAttempts` to `2` only to permit one orchestrator retry for a classified transient failure; semantic failures remain blocked.

Start with a draft approval:

```json
{"status":"draft","digest":null,"approvedAt":null,"approvedBy":null}
```

## Validate before presenting

Run:

```text
iwf validate --plan .github/issue-plans/<plan-id>/plan.json
```

Fix every schema, contract digest, dependency, and traceability error. Review the plan as a specification: check boundary omissions, unsafe defaults, unverifiable acceptance, regression risks, and paths broader than the task needs.

Present the behavior contract, task sequence, assumptions, and computed digest for review. Publish only after the user explicitly asks:

```text
iwf plan publish --plan .github/issue-plans/<plan-id>/plan.json
```

The planning PR merge is the only business approval. Any later change to requirements, scope, dependencies, allowed paths, acceptance, workflow version, Runner, model, or base commit requires a new plan ID and planning PR.
