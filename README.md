# branch-reviewer-sdk

Branch review agent built on the Claude Agent SDK, running on subscription
credit. Fresh-start successor to
[branch-reviewer-api](https://github.com/racoonamatatas/branch-reviewer-api),
which hand-rolls the same agent loop against the raw Messages API — kept as
the learning artifact and comparison baseline.

Read-and-report only: reviews a GitHub branch against its merge base and
reports structured findings. No editing, no fixing.

## Setup

```
npm install
```

Auth is subscription credit only — the reviewer refuses to run if
`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set, so a run can never
silently bill pay-as-you-go. Locally, log in with `claude` as usual. On a
headless machine, put a token from `claude setup-token` in `.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=...
```

Optional `.env` vars:

- `GITHUB_TOKEN` — raises GitHub's rate limit and is required for private repos.
- `REVIEW_MODEL` — defaults to `claude-opus-5`.

Every command below except `history` calls the model and burns real
subscription credit — don't run them as casual checks. (`serve` is free to
start; every job it executes bills like the equivalent command.)

## Commands

### `npm run review`

Review one branch against its merge base.

```
npm run review -- <owner>/<repo> <branch> [--base main] [--max-turns N] [--verbose] [--no-save]
```

Prints structured findings and exits 0 (clean), 1 (a critical finding), or 2
(aborted). Saved to run history unless `--no-save`.

### `npm run history`

```
npm run history [-- <run-id>]
```

No args lists stored runs (id, date, target, status, finding count, cost).
With a run id, shows that run's full stored report.

### `npm run consolidate`

```
npm run consolidate -- <run-id> <run-id> [...]
npm run consolidate
npm run consolidate -- --show <consolidation-id>
```

With run ids, clusters those runs' findings via the judge and saves+prints a
consolidation. Runs must target the same owner/repo/head/base and each must
have a completed review. No args lists stored consolidations; `--show`
reprints a saved one.

### `npm run verify`

```
npm run verify -- <consolidation-id> [--max-turns N] [--reverify]
```

Adjudicates the consolidation's occurrence-1 clusters (findings seen by only
one run) that are still pending a verdict, one adversarial agent per cluster.
`--reverify` re-tests clusters that already have a verdict. Reprints the
consolidation with verdicts attached.

### `npm run campaign`

```
npm run campaign -- <owner>/<repo> <branch> [--base main] [--max-runs N] [--patience K] [--max-turns N] [--no-verify] [--reverify]
```

Repeats review rounds on one target until discovery dries up (`--patience`
rounds in a row with no new finding, default 2), the run cap is hit
(`--max-runs`, default 3), or two consecutive rounds abort. Consolidates
after every round; verifies pending singleton findings at the end unless
`--no-verify`.

### `npm run serve`

```
npm run serve [-- --port N]
```

Job server on `http://127.0.0.1:4780` (localhost only): review and campaign
requests queue as jobs in the same database as run history, and a single
sequential worker executes them — back-to-back runs of one target ride each
other's prompt cache, so parallelism would cost more, not less. Enqueued jobs
bill credit exactly like the CLI commands; the server refuses to start if a
pay-as-you-go credential is set.

```
POST /jobs                  enqueue: {"kind": "review"|"campaign", "owner", "repo", "head",
                            "base"? (main), "params"?} — params mirror the CLI flags
                            (campaign defaults: 3 runs, verify on)
GET  /jobs                  list job summaries, newest first
GET  /jobs/<id>             one job: state, error, run ids as rounds land, consolidation
POST /jobs/<id>/cancel      cancel a queued job (409 once running — its credit is spent)
```

Jobs end `succeeded`, `aborted` (turn cap, or a campaign with two consecutive
unusable rounds), or `failed` (the error is stored on the job). A job found
`running` at startup was interrupted and is marked failed — never silently
re-run; re-enqueue it deliberately.

## Eval

Regression harness for the clustering judge, separate from `npm test`
because the judge is stochastic.

```
npm run eval:freeze -- <consolidation-id>
npm run eval:judge
```

`eval:freeze` snapshots a human-verified consolidation into `eval/fixtures/`
(gitignored) as the judge's golden set. `eval:judge` replays it through the
judge and scores the resulting partition against that frozen answer — a
fail is a signal to inspect, not a hard failure.
