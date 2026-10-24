# pr-evidence

A Claude Code mod (function-hook plugin) that gives the model one read-only tool, `pr_evidence`, for a snapshot of a GitHub pull request at one exact commit: its metadata, a frozen diff, CI status (Actions runs, check runs, legacy commit statuses) and the failed jobs' log tails. Everything is pinned to one repository and one full SHA, absence and uncertainty are reported as such, and the output has fixed size limits. It never waits, polls, caches or triggers anything.

## Behavior

- At `session.start` the mod registers the tool `mcp__pr-evidence__pr_evidence` (behind ToolSearch) and the `/pr-evidence` command. The tool list doesn't change after that, whatever the mode.
- The model calls the tool; the mod runs `gh` (your existing `gh auth login`) and, for the workspace shorthand, `git rev-parse HEAD`, one process at a time, and returns one JSON string.
- Main conversation only by default: a call from a subagent is refused unless `allowSubagents` is on.
- Off (`/pr-evidence off` or `enabled: false`): calls are refused before any process starts. Turning it off while a call is collecting makes that call return a refusal instead of evidence.
- It never runs anything that writes: no `POST`/`PATCH`/`PUT`/`DELETE`, no reruns, no `workflow run`, no `pr checkout`, no `auth` commands. Every REST call is `gh api --method GET` (`gh api -f` would otherwise send POST).

## Tool input

| Field | Type | Meaning |
| --- | --- | --- |
| `repo` | `OWNER/REPO` | The base repository on github.com. |
| `pr` | positive integer | The pull request number. Needs `repo`. |
| `sha` | 40 hex characters | A full commit SHA. With `pr` it is a guard: it must equal the PR's head. Needs `repo`. |
| `sections` | array of `metadata`, `diff`, `ci`, `logs` | What to collect; default all four. `logs` implies CI discovery. |

Unknown fields are refused.

### Resolution

- `repo` + `pr`: read the PR and pin its current head SHA. A `sha` that differs is an error.
- `repo` + `sha`: check that the commit exists, then look for a PR whose current head is that SHA. Candidates come from two sources, because neither is complete alone: `commits/{sha}/pulls` (open and merged PRs, but not every closed, unmerged one) and a search for PRs in the repository that contain the SHA (`search/issues`, which can lag new PRs). Each search hit is confirmed by reading the PR (at most five). One match gives metadata and diff; none is `no_pr_found`, several are `ambiguous` with the candidate numbers, and CI is still collected for the SHA either way. Both carry `association.complete`: false when a source failed or was cut short. Even `true` is not proof that no PR exists.
- No fields (workspace shorthand): `gh pr view` for the current branch in the session's directory, and local `git rev-parse HEAD`. The repository comes from the PR's URL. Local HEAD must equal the PR's head: an unpushed or stale checkout is an error, not evidence for a different commit.
- Anything else (`pr` or `sha` without `repo`, `repo` alone) is refused. There is no branch input.

## Output

One JSON string, `schema_version: 1`:

- `identity`: `host` (`github.com`), `repo`, `sha`, `pr` (or null), `resolved_by`.
- `observed`: `started_at` and `finished_at`. A snapshot never claims CI has settled; another run can still appear.
- `collection`: `complete`, `partial` or `error`, decided last, after the final size fit. `error`: resolution failed, nothing below it is evidence. `partial`: any entry in `errors` or `omissions` (a failed command, a truncated capture, anything cut for a limit), or any section that reports itself incomplete. `complete`: none of these. Every incomplete section has a reason in `errors` or `omissions`; one the mod didn't anticipate is reported as `unaccounted_gap`.
- `metadata`: title, state, draft, merged, author, URL, base and head (ref, SHA, repository), counts, body (stripped, cut at 4 KiB).
- `diff`: a frozen comparison `base...head` from GitHub's compare API with `base_sha`, `merge_base_sha`, `head_sha` and per-file patches. It is not a verbatim unified diff: GitHub lists at most 300 files and omits patches for binary and very large files (`patch_unavailable`, never an empty patch).
- `ci.workflows`: every Actions run for the SHA (distinct run IDs, not collapsed by workflow name), with its latest attempt and, for failed runs, the failed jobs and steps.
- `ci.checks`: the latest check runs for the SHA, with the app that owns each. `ci.statuses`: the legacy combined status's contexts, with GitHub's own combined `state` kept as `combined_state_from_github` (it says `pending` when there are no statuses at all; the mod's `state` says `none`).
- `ci.observed_outcome`: the overall state and counts (see below). `ci.required_checks` is always `"not_evaluated"`.
- `logs.jobs`: for up to five failed jobs, the failed steps' log tails when attribution is reliable; otherwise `attribution: "step_logs_unavailable"` with a reason and two labelled fallbacks (below).
- `omissions`: everything left out for a limit, with a count (or `"unknown"`) and the reason. `errors`: every failed command, classified (`not_found`, `auth`, `rate_limited`, `timeout`, `truncated`, `malformed`, `mismatch`, ...), and every list item GitHub returned that couldn't be used: an unreadable run, job, PR or search hit is `malformed`, and a run or job for another commit or attempt is `mismatch`. Nothing is dropped from a list without an entry here, and either makes its section incomplete.

### Outcome rules

These are the contract; each is a test.

1. A commit with no Actions runs is `no_workflows` in `ci.workflows`, never green. A commit that doesn't exist is an error, not `no_workflows`.
2. Queued, waiting or running work is `pending` and stays counted (`pending`, `has_pending`) even when there are failures too.
3. Unknown conclusions, failed or incomplete discovery (more than 100 runs, a failed page, malformed JSON, truncated capture) make the result `inconclusive`, never `observed_passed`.
4. All skipped or neutral is `skipped_only`, not passed.
5. A known failure stays visible (`failing`) even if other sections fail.
6. An empty legacy combined status (`total_count` 0, which GitHub reports as `pending`) is absence (`none`), not a pending check.
7. `observed_passed` means every observed item passed; it never means "merge permitted".

Classes: `success` passes; `neutral` and `skipped` are neutral; `failure`, `timed_out`, `cancelled`, `startup_failure`, `action_required` and `stale` fail (statuses `failure` and `error` fail); anything not completed (statuses `pending`) is pending; anything else is unknown.

The overall `ci.observed_outcome.state` is the first that applies: `failing` (any failure in any section), `pending`, `inconclusive`, `no_workflows` (no Actions runs, no check runs and no statuses), `skipped_only`, `observed_passed`. When there are no Actions runs but another app's check runs passed, the overall state is `observed_passed` and `ci.workflows.state` still says `no_workflows`.

Whenever Actions runs were found, the snapshot reads the run list once more at the end, after everything else, and merges the two reads by run ID. A run in the final read counts in its final state; if it changed (new attempt, new status) it is marked `changed_during_collection`, and jobs and logs collected for its older attempt are dropped and listed in `omissions`. A run the final read doesn't list is kept as first observed, with `listing: "not_in_final_page"` (the final page was full) or `"no_longer_listed"`, so a known failure never disappears; that also makes `ci.workflows` incomplete. Runs only the final read lists are added. If the final read fails, the first can't be confirmed (`listing: "not_rechecked"`): `ci.workflows` is incomplete and the result is `inconclusive` unless something failed.

### Logs

`gh run view --log-failed` prints `job<TAB>step<TAB>line`. A failed step's tail (last 30 lines, at most 4 KiB) is returned only when every failed step's name is unique in the job and appears in the log, and no line is `UNKNOWN STEP`. Current GitHub logs often come back as `UNKNOWN STEP`; then the job gets `step_logs_unavailable` and:

- `job_tail`: the last 30 lines of the whole failed-job log, labelled as such. Cleanup steps that ran after the failure (`Post ...`, credential removal) often fill it.
- `error_marker_excerpt`: the lines from the last `##[group]Run` marker before GitHub's first `##[error]` marker up to that marker (its last 30 lines), and the first ten `##[error]` lines. These are GitHub's own markers, not a step attribution.

A capture over 4 MiB, an expired log or a failed download gives no tail at all.

A run that is failed in the final result but whose jobs weren't read for that attempt carries `jobs_not_inspected` with the reason: `failed_during_collection` (it failed, or was rerun, between the first and final reads), `ceiling_failed_runs_inspected` (past the five-run limit) or `jobs_unavailable` (the jobs request failed). Each such run is also counted in `omissions` (`ci.workflows`, "jobs of failed runs", by reason), so `collection` is `partial` whether or not logs were requested; when they were, the runs are listed in `logs.runs_not_inspected` too, with a `logs` omission. The snapshot doesn't go back for them; call the tool again. Timestamps are removed from log lines, lines are cut at 400 characters, and terminal control sequences are stripped from logs, patches and PR text.

## Limits

Fixed ceilings: 30 process invocations per call, one at a time; each at most 20 s and never past the call's `timeoutSeconds`; 100 runs, 100 check runs and 100 status contexts (one page each); 100 jobs per run; jobs for at most 5 failed runs; logs for at most 5 failed jobs; 30 lines and 4 KiB per tail; 16 KiB of logs; 24 KiB of patches (8 KiB per file); 4 KiB of PR body. The whole result fits `maxOutputKiB`: patches and log lines are dropped first, and each drop is listed in `omissions`. Invocation counts are not HTTP-request or download-size guarantees: `gh run view` downloads the job's log archive.

## Command

`/pr-evidence [on|off|status]`: show or set whether the tool answers in this session.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the tool on for new sessions. `/pr-evidence on|off` overrides it per session. |
| `allowSubagents` | `false` | Let subagents call the tool too, with the same limits. |
| `timeoutSeconds` | `120` | Deadline for one call, 10 to 600. Sections not reached by then are listed as not collected. |
| `maxOutputKiB` | `64` | Largest result, 16 to 64 KiB. |

## Cost

No model calls of its own. The result is a tool result the model reads, so it costs input tokens like any other: up to `maxOutputKiB` (64 KiB is roughly 16K tokens) per call. Each call uses your GitHub API rate limit: about 6 to 25 REST requests, plus log downloads. The repo+sha form also makes one search request, which counts against GitHub's separate search rate limit (30 a minute).

## Contract

In scope: github.com; your existing `gh` authentication; one base repository; full 40-character SHAs; association by current PR head (best effort, see Resolution); frozen comparison patches; Actions runs, latest check runs and combined legacy statuses for the exact SHA; bounded failed-job logs, attributed to steps only when reliable.

Out of contract:

- required checks, rulesets and branch protection (`required_checks` is always `not_evaluated`);
- merge queues and merge-commit SHAs standing in for the head;
- PR metadata as it was at an older commit;
- CI that runs in a fork's own repository rather than the base repository;
- logs of external CI providers (their check runs are listed, their logs are not fetched);
- complete patches for huge or binary files, and PRs past GitHub's 300-file compare listing;
- step attribution when GitHub's log doesn't provide it;
- GitHub Enterprise Server;
- anything that writes: reruns, workflow dispatch, comments, checkouts.

## Limitations

Cut from this first version, on purpose:

- No waiting or watching. Call it again for a fresh snapshot, or wait with a background command first.
- No reviews, review comments or PR conversation.
- No pagination past the first page of runs, check runs, statuses and jobs; more is reported as an omission and makes the result inconclusive.
- No full-log files on disk; only bounded tails.
- No secret masking: logs are returned as GitHub serves them (GitHub masks registered secrets itself).
- A snapshot can't prove nothing changed between its reads; it re-reads run headers once at the end and reports what changed.
- `gh` rate limiting is reported, not retried.
- The workspace shorthand relies on `gh pr view`'s own lookup of the PR for the current branch.
- A diff, log or body cut for a limit makes `collection` `partial`, like a failed section; read `omissions` and `errors` to tell them apart.

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-pr-evidence
claude plugin install pr-evidence@pr-evidence --scope user
```

Or from inside Claude Code: `/plugin install pr-evidence --marketplace chrisvaillancourt/claude-pr-evidence`.

Needs the GitHub CLI (`gh`) on your `PATH`, logged in to github.com.

To work on it locally, add your clone as the marketplace instead (`claude plugin marketplace add <path to clone>`). The plugin is read from that folder; after editing, run `/reload-plugins`.

## Update

```sh
claude plugin marketplace update pr-evidence
claude plugin update pr-evidence@pr-evidence
```

Then restart Claude Code.

## Develop

```sh
scripts/check.sh
```

It runs `claude plugin validate .`, `claude plugin test .` and a TypeScript check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. See [LICENSE](LICENSE).
