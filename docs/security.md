# Security and secret operations

Issue Workflow Kit v2 separates the GitHub automation identity from the Codex
execution identity. Do not reuse either credential for unrelated automation.

## `IWF_TOKEN`

Create a dedicated bot account and a fine-grained personal access token. Limit
repository access to the repositories managed by IWF. The token needs these
repository permissions for the current v2 workflow:

- Actions: read and write, for workflow inspection and dispatch.
- Contents: read and write, for branches, commits, workflow files, and merges.
- Issues: read and write, for managed Issues, labels, comments, and relations.
- Pull requests: read and write, for task PRs, reviews, checks, and squash merge.
- Administration: read, for branch-protection and repository policy checks in
  `iwf doctor`.
- Workflows: read and write when an approved task may change files under
  `.github/workflows/`; otherwise omit it.
- Metadata: read, which GitHub grants with repository access.

Select an expiration date permitted by the organization. Prefer a short,
operationally realistic lifetime and rotate before expiry. Organization policy
or GitHub API changes may require an additional permission; run `iwf doctor`
after creation and after every permission change instead of broadening the token
pre-emptively.

Store the value as the repository or organization Actions secret `IWF_TOKEN`.
The reusable workflow injects it only into orchestration steps. Runner and
review processes reject `IWF_TOKEN`, `GITHUB_TOKEN`, and `GH_TOKEN` in their
environment.

Managed Issues, event comments, and task PRs are accepted by the state machine
only when GitHub reports the current automation account as their creator. Token
rotation must therefore keep the same dedicated bot account. Moving to another
account is an identity migration and requires a new approved plan; do not make
the new account silently trust markers written by the previous identity.

## `CODEX_API_KEY`

Create a separate OpenAI API key for the Runner identity and store it as the
Actions secret `CODEX_API_KEY`. It is injected only into the individual
`codex exec` process used for implementation or review. It is not a GitHub
credential and must never be passed to orchestration commands.

## Rotation and revocation

1. Create the replacement credential for the same bot account with the same or
   narrower scope.
2. Update the Actions secret without committing the value anywhere.
3. Run `iwf doctor`, then dispatch a controlled validation run.
4. Revoke the previous credential after the validation run succeeds.
5. If compromise is suspected, revoke first, replace second, and inspect Actions
   logs, artifacts, Issue comments, PRs, and branches created since the suspected
   exposure time.

Record credential owner, repository scope, creation date, expiry date, rotation
date, and revocation procedure in the organization's secret inventory. Do not
record the credential value or a recoverable derivative.

## Logging and artifacts

Secrets must not appear in plans, behavior contracts, task envelopes, task
completion records, review reports, Issues, PR bodies, comments, artifacts,
command arguments, or committed files. The Runner validates structured output
for secret-like values and local absolute paths before publishing it. Keep raw
Codex output ephemeral; only validated protocol documents and a credential-free
Git bundle are uploaded.

Avoid shell tracing (`set -x`) in workflow steps that receive secrets. Treat a
secret appearing in any log or artifact as compromised even if GitHub masks the
displayed value.

## Required repository controls

- Enable Issues and squash merge; enable repository auto-merge.
- Protect the default branch and disable force pushes.
- Require every check listed in `.github/issue-workflow.yml`.
- Restrict who may alter Actions secrets and workflow files.
- Pin the reusable workflow to an immutable release tag and protect that tag.
- Keep task execution serial through the repository concurrency group.

Run the read-only preflight before publishing a plan or after changing branch
protection, secrets, permissions, Codex version, or the pinned Kit revision:

```bash
node bin/iwf.mjs doctor --root /path/to/target --repo owner/repository
```

`doctor` reports secret names and capability checks only. It never reads or
prints secret values.
