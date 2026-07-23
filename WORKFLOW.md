# Issue Workflow Kit

This file is the repository's remote entry point for an agent that plans and
delivers work through GitHub Issues. It is intentionally tool-agnostic: an
agent may be a person, a shell script, or an AI system. The GitHub CLI examples
below are concrete commands, but the required behavior is the contract rather
than a particular client.

## Rules that apply first

1. Read this file at the `workflow.repository` and `workflow.revision` recorded
   by the plan. Then inspect the target repository's `AGENTS.md` files (from the
   repository root down to the files being changed). Target-repository
   instructions have priority over this file. Never copy, generate, overwrite,
   or delete an `AGENTS.md` as part of this workflow.
2. Read the approved plan from `.github/issue-plans/<plan-id>.json`. A plan is
   not approved merely because it is present: `approval.status` must be
   `approved`, and its SHA-256 digest must match the canonical plan content.
3. Treat GitHub as shared state. Before changing an Issue, branch, or pull
   request, reread its current state and stop if it contradicts the approved
   plan or another active change.
4. Do not expose tokens in files, logs, Issue bodies, PRs, or command history.
   Use the least privilege that can read and write repository Issues and pull
   requests; Projects permission is not part of this workflow.

## Plan contract versions

Issue Plan v1.0 remains supported by `.github/issue-plan.schema.json` without
changes. Issue Plan v1.1 uses `.github/issue-plan.v1.1.schema.json`; validation
dispatches by `schemaVersion` and requires `$schema` to resolve to the matching
file. Existing approved v1.0 plans and their digests remain valid.

In v1.1, an Epic or Task may declare `management` with `owner`,
`estimateHours`, `dueDate`, `cycle`, and `tags`. An owner is added only after
GitHub confirms the account is assignable; existing assignees are never
removed. `tag:<slug>` and `cycle:<slug>` are managed labels. Estimate and due
date appear only in the managed Issue body, so GitHub Projects is not needed.

An Epic or Task may also declare `execution`: `agent`, the required
`commitPolicy`, `allowedSideEffects`, runtime and heartbeat limits,
`maxAttempts`, and non-empty `requiredChecks`. Defaults are 7200 seconds, 300
seconds, and one attempt. A retry is allowed only when the approved plan
explicitly raises `maxAttempts`. `allowedSideEffects` is an agent contract; it
does not provide an operating-system or network sandbox.

## Planning mode

Planning mode produces a reviewable contract. It does not create or update
Issues, labels, branches, or pull requests for implementation.

### 1. Inspect and clarify

- Identify the target `owner/repository`, default branch, current revision,
  repository instructions, and relevant existing code and tests.
- Describe the user outcome, current evidence, expected behavior, and failure
  behavior. Ask focused questions when a missing decision would change scope,
  data ownership, security, or acceptance.
- Record assumptions explicitly. An assumption that changes the allowed paths,
  dependencies, or public behavior is a decision, not an implementation detail.

### 2. Make atomic tasks

Every task in an Epic must be independently verifiable and small enough for one
focused implementation and one squash PR. A task has one observable outcome,
one owner at a time, explicit allowed paths, and a finite verification command.
It must state:

- goal and user value;
- current context and expected behavior, including failure behavior;
- implementation scope and paths that may be changed;
- explicit exclusions and data/API constraints;
- priority, task dependencies, acceptance criteria, and verification steps.

Do not hide work in a vague Epic criterion. If a change crosses a boundary,
split it into ordered tasks and make the dependency explicit. Tasks are
executed sequentially; dependency order is authoritative even when independent
work might appear parallelizable.

### 3. Approve and freeze

Write the complete plan to `.github/issue-plans/<plan-id>.json` and validate it
before requesting approval. The approval digest is SHA-256 over UTF-8 canonical
JSON: recursively sort object keys, preserve array order, and omit the root
`approval` object. Whitespace and key-order changes therefore do not change a
digest, while any substantive plan change does.

The planning PR must show the whole plan and its digest. Do not create the
Epic, tasks, labels, or relationships until that PR is approved and merged.
After approval, the plan is immutable. A changed goal, boundary, dependency,
verification step, allowed path, or task disposition requires a new planning
PR, a new digest, and a new approval. Never silently edit an existing plan or
expand an Issue to absorb an unapproved request.

## Execution mode

Execution starts only after the approved planning PR is on the target default
branch.

### Bootstrap and identities

Create the fixed labels (`type:epic`, `type:task`, `priority:P0`, `priority:P1`,
`priority:P2`, `status:backlog`, `status:ready`, `status:in-progress`, and
`status:blocked`, and `status:in-review`) and then create one Epic and its
native Sub-issues. Each
Issue body contains a machine-readable identity marker with `planId`, `taskId`,
and `workflowRevision`. This marker, not the title, is the stable identity.
The title may be edited by a human without causing a duplicate on the next
synchronization.

Create the native parent/child and `blocked by` relationships after all Issue
identities exist. Keep relationships declared by other plans or people. A
synchronizer may remove only a relationship owned by the same plan that is no
longer declared; it never deletes an Issue and never closes a task removed from
a plan.

New tasks with no task dependency receive `status:ready`; tasks with an
unclosed dependency and the Epic receive `status:backlog`. The synchronizer
sets an initial status only when an Issue is first created. Thereafter it may
manage type, priority, declared PM labels, owner, and its marked body, but it
preserves the current status, closed/open state, human assignees, extra labels,
and all unmarked human text.
Closing an Issue is the completion signal; do not invent a `status:done` label.

### Runtime records and comments

Each claim derives a `task-execution/v1` envelope from the approved plan. It
contains the plan, task, Issue, approval digest, attempt, agent, branch,
allowed paths, execution policy, acceptance runs, and verification runs.
Acceptance IDs use `<task-id>-AC01`; verification IDs use `<task-id>-V01`.
The envelope and `task-completion/v1` result use canonical JSON SHA-256.

Each attempt owns one mutable status comment. Block, submit, complete, stale,
and superseded transitions use immutable event comments. Stable HTML markers
contain managed JSON. Comments must not contain secrets, local absolute paths,
full logs, or binary data. An artifact records only a URL, short summary, and
optional SHA-256.

The lifecycle is:

```text
backlog -> ready -> in-progress -> blocked -> in-progress
                              \-> in-review -> closed
```

An expired attempt becomes blocked and is never retried automatically. For
concurrent claims, the earliest valid GitHub claim comment wins; every loser
records `superseded`, stops, and does not change the Issue status.
Block kind is exactly one of `dependency`, `needs-input`, `capability`,
`transient`, `verification`, or `stale`.

### One task at a time

1. Select exactly one open `status:ready` task whose dependencies are closed.
   Change it to `status:in-progress` and record the transition in the Issue.
2. Fetch the latest default branch and create a dedicated branch. Read the
   Issue again, then change only files in its `allowedPaths`; do not edit
   generated plans, unrelated tasks, or repository instructions unless the
   task explicitly allows them.
3. Implement the smallest complete change. Add or update tests in the declared
   paths. Run every verification step and the repository's required checks.
4. Open one PR for the task. The PR body must contain `Closes #<issue-number>`
   and summarize the acceptance evidence. Set the task to `status:in-review`
   and request squash auto-merge. Do not start another task while this PR is
   open.
5. After CI passes and the squash PR merges, confirm the Issue is closed and
   then set the next dependency-unblocked task from `status:backlog` to
   `status:ready`. A failed check, unresolved dependency, or merge conflict
   stops this sequence.

For a v1.1 runtime, perform those transitions with these commands. Every
command also requires `--plan`, `--repo`, and `--approval-digest`, emits JSON
to stdout, and sends diagnostics only to stderr.

```text
npm run task:claim -- --plan <plan> --repo <owner/repo> --approval-digest <sha256> --task-id <id> --agent <agent>
npm run task:heartbeat -- --plan <plan> --repo <owner/repo> --approval-digest <sha256> --attempt-id <id> [--note <text>]
npm run task:block -- --plan <plan> --repo <owner/repo> --approval-digest <sha256> --attempt-id <id> --kind <kind> --reason <text>
npm run task:resume -- --plan <plan> --repo <owner/repo> --approval-digest <sha256> --task-id <id> --from-attempt <id> --agent <agent>
npm run task:submit -- --plan <plan> --repo <owner/repo> --approval-digest <sha256> --attempt-id <id> --pr <number-or-url> --result <file|->
npm run task:reconcile -- --plan <plan> --repo <owner/repo> --approval-digest <sha256>
```

The default branch is `iwf/<task-id-lowercase>-a<attempt-number>`. Submit reads
the authoritative PR file list and checks every added, modified, removed, and
renamed path, including both rename names, against exact `allowedPaths` or a
declared `/**` directory prefix. It also requires a matching repo/base/head,
complete successful evidence, and literal `Closes #<issue>` text. A validation
failure performs no write; partial or failed results become blocked.

Reconcile records completion only after the submitted PR is merged, all
required checks exist and succeed, no check is pending or failing, the PR head
and evidence are unchanged, and the Issue was closed by that PR's closing
reference. Manual closure, a missing check, a failed check, or an unmerged PR
never completes or unlocks a task. A successor becomes ready only after every
dependency has a valid complete event. Reconcile never closes Issues, creates
attempts, or removes human relationships.

### Stop conditions and recovery

Stop before making further changes when any of these occurs: CI failure; an
authentication, permission, API, or GraphQL error; a missing or changed
workflow/plan revision; a digest mismatch; an Issue or dependency that does
not match the plan; a request outside the task's scope or allowed paths; or a
new requirement that changes acceptance, data handling, security, or public
behavior. Report the evidence and leave the current state intact. Do not start
the next task, retry a write blindly, or close an Issue to make the sequence
look complete.

Runtime commands additionally stop on a stale or superseded attempt, a changed
PR head, missing completion evidence, pending or failing checks, a manual Issue
closure, exhausted `maxAttempts`, or a file outside `allowedPaths`. They do not
silently retry or advance a dependency after any of these conditions.

For a transient API/rate-limit failure, retry with bounded backoff only when the
operation is known to be idempotent. For a partial failure, reread remote state
and rerun the synchronizer; it must reuse identities and preserve state. Never
delete Issues or automatically close tasks that disappeared from a later plan.

Cancellation, reprioritization, and removal require an explicitly approved
plan revision that records the disposition and a human confirmation in the
affected Issue. Until then, the previous approved plan remains authoritative.

## Required completion evidence

An execution is complete only when every acceptance criterion is checked, all
verification commands pass, the corresponding squash PRs are merged, and the
Epic's native children and dependencies reflect the approved plan. Report the
plan ID, approved digest, Issue/PR URLs, test results, and any deliberately
preserved manual state. A green local test alone is not evidence that the
remote workflow is complete.
