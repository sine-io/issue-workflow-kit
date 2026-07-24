# Bootstrap and fault-drill runbook

This runbook is for the Kit repository itself. A successful local test run is
not a substitute for these GitHub-hosted release rounds.

## One-time v1 launch exception

1. Record the current v1-approved plan, task Issue, implementation PR, checks,
   and merge SHA that produced `v2.0.0-alpha.1`.
2. After that PR is merged, create the protected `v2.0.0-alpha.1` tag at its
   merge commit. This is the only manually created bootstrap tag.
3. Add `IWF_TOKEN` and `CODEX_API_KEY`, configure the controls from
   `docs/security.md`, and run `iwf doctor`.
4. Confirm `.github/issue-workflow.yml` and the caller Workflow both pin
   `v2.0.0-alpha.1`. Do not dispatch an implementation task manually.

## Alpha to stable

Create and merge one v2 planning PR whose tasks implement the stable release.
The final task must:

- update the package version and release-facing documentation;
- update the repository config and caller to the stable tag;
- declare `github:tag:v2.0.0` in `execution.allowedSideEffects`;
- allow only the exact files needed for that release transition.

After both independent reviews and required checks pass, IWF squash-merges the
task PR, creates `v2.0.0` at the merge commit, records the tag in the completion
event, and dispatches the caller from the default branch.

## Stable to patch

Repeat the same process with a new immutable plan and a final release task that
declares `github:tag:v2.0.1` and moves both pins to `v2.0.1`. The planning PR
merge remains the only human business approval.

## Fault drills

Run each drill in a disposable approved plan. A drill passes only when the
current task becomes blocked, no merge occurs, and no successor is claimed.

| Drill | Injection | Required evidence |
| --- | --- | --- |
| Scope | Modify a path outside `allowedPaths` | blocked scope completion; no task PR |
| Verification | Make an approved verification command fail | blocked verification completion; no task PR |
| Review | Return `changes-requested` from either independent review | open PR, immutable review event, no merge |
| Stale | Stop after claim beyond the approved runtime | non-retryable stale event; successor remains backlog |
| Digest | Change contract or plan bytes after approval | validation failure before Issue or branch write |
| Closing scope | Add a second managed closing reference | submission rejection before review |

Transient service failure is a separate recovery drill: classify one simulated
rate-limit/network failure, observe exactly one second attempt, then verify that
a second failure remains blocked.

## Release evidence

For each of the two release rounds retain:

- planning PR URL, merge actor, plan digest, contract digest, and base SHA;
- stable task ID to Issue, attempt, PR, submitted head, and squash SHA mapping;
- task envelope/completion digests and complete acceptance/verification evidence;
- spec and code review documents tied to the submitted head;
- required check conclusions and authoritative closing-Issue reference;
- completion event, created release tag, and next-workflow dispatch;
- fault-drill Issues and their terminal blocked events.

The two release tags, default-branch history, PR files, Issue events, and Actions
runs must be sufficient to replay the sequence without relying on local files.
