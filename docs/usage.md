# Usage

Setup, the full command reference, and the judge eval harness for
branch-reviewer-sdk. The [README](../README.md) covers what the pipeline is
and why it is built this way.

## Setup

```
npm install
```

Requires Node ≥ 24 (the store runs on built-in `node:sqlite`).

Auth is subscription credit only. Locally, log in with `claude` as usual. On
a headless machine, put a token from `claude setup-token` in `.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=...
```

Optional `.env` vars:

- `GITHUB_TOKEN` — raises GitHub's rate limit; required for private repos.
- `REVIEW_MODEL` — reviewer model, default `claude-opus-5-5`. Any model id
  works; the 5.5 ids (`claude-opus-5-5`, `claude-sonnet-5-5`) need Agent SDK
  ≥ 0.3.280, which the pinned 0.3.310 satisfies.
- `REVIEW_MODELS` — comma list; campaigns rotate the review model per round.
  Unset, campaigns use the reviewer model alone.
- `JUDGE_MODEL` — clustering judge, default `claude-sonnet-5`.
- `VERIFY_MODEL` — verifier for critical and warning findings, defaults to
  the reviewer's model.
- `VERIFY_NIT_MODEL` — verifier for nits, default `claude-sonnet-5-5`.

Every command below except `history` calls the model and burns real
subscription credit — don't run them as casual checks. (`serve` is free to
start; every job it executes bills like the equivalent command.)

## Commands

### `npm run review`

Review one branch against its merge base.

```
npm run review -- <owner>/<repo> <branch> [--base main] [--max-turns N] [--verbose] [--no-save]
```

Prints structured findings (severity and reviewer confidence per finding)
and exits 0 (clean), 1 (a critical finding), or 2 (aborted — turn cap). An
empty diff exits 0 before any model call: nothing was reviewed and no credit
moved. Saved to run history unless `--no-save`.

### `npm run history`

```
npm run history [-- <run-id>]
```

No args lists stored runs (id, date, target, status, finding count, cost).
With a run id, shows that run's full stored report.

### `npm run consolidate`

```
npm run consolidate -- <run-id> [<run-id> ...]
npm run consolidate
npm run consolidate -- --show <consolidation-id>
```

With run ids, clusters those runs' findings via the judge and saves+prints a
consolidation (judge cost included). A single run is valid: clustering is
what makes its findings verifiable. Runs must target the same
owner/repo/head/base and each must have a completed review. No args lists
stored consolidations; `--show` reprints a saved one.

### `npm run verify`

```
npm run verify -- <consolidation-id> [--max-turns N] [--reverify] [--verify-all]
```

Adjudicates the consolidation's pending queue — one settlement agent per
cluster. Queued by default: clusters without **cross-model** corroboration
(a claim repeated by one model across rounds is that model re-deriving its
own prior, not independent agreement — observed live when an empirically
false claim recurred three times, every sighting from the same model), plus
clusters whose members absorbed a previously-adjudicated set. `--verify-all`
queues every pending cluster regardless of corroboration — the posture for
findings a human will be handed as fact. `--reverify` re-tests clusters
that already have a verdict. Reprints the consolidation with verdicts
attached.

### `npm run campaign`

```
npm run campaign -- <owner>/<repo> <branch> [--base main] [--max-runs N] [--patience K] [--max-turns N] [--no-verify] [--reverify] [--verify-all] [--models a,b] [--no-lenses]
npm run campaign -- --force-fail <campaign-id>
```

Repeats review rounds on one target until discovery dries up (`--patience`
rounds in a row with no new finding, default 2), the run cap is hit
(`--max-runs`, default 3), the diff turns out empty, two judge calls in a
row fail, or rounds become unusable — two consecutive rounds aborted, or one
model's two rounds in a row.
Consolidates after every round; verifies the pending queue at the end unless
`--no-verify`. The summary itemizes review, judge, and verification spend.

Rounds are diversity-sampled by default: each round takes a lens — the
generalist slot, then security, concurrency, config-and-deploy, tests — that
redirects attention without narrowing what may be reported (`--no-lenses`
disables). The lens is chosen from the target's stored runs, least-sampled
first, so a follow-up campaign resumes the rotation rather than restarting it
at generalist; a target with no history plays out in the order above.
`--models a,b` additionally cycles the review model per round (least paired
with the round's lens first), making recurrence cross-model agreement. The
lens rides the user prompt, so the system prompt stays the prefix every
round shares in the prompt cache; what rotation forfeits is cache reuse on
the rest of the input — a cost, not a statistical trade, since identical
inputs are the correlation. Lens and model are recorded on each run.

Campaigns are persisted with a liveness lease, so a `running` record whose
process died is detected and closed on the next start. A record that can't
be proven dead (wedged) is retired by hand with `--force-fail <campaign-id>`.

### `npm run serve`

```
npm run serve [-- --port N] [--poll-interval seconds]
```

Job server on `http://127.0.0.1:4780` (localhost only): review, campaign,
and verify requests queue as jobs in the same database as run history, and a
single sequential worker executes them. Enqueued jobs bill credit exactly
like the CLI commands; the server refuses to start if a pay-as-you-go
credential is set. Serves the built dashboard (`npm run dashboard:build`)
when present.

```
POST /jobs                  enqueue: {"kind": "review"|"campaign"|"verify", "owner", "repo",
                            "head", "base"? (main), "start"? (false), "params"?} — params
                            mirror the CLI flags; without "start": true the job is held
                            until released
GET  /jobs                  list job summaries, newest first
GET  /jobs/<id>             one job: state, error, run ids as rounds land, consolidation
POST /jobs/<id>/cancel      cancel a queued job (409 once running — its credit is spent)
POST /jobs/<id>/release     the billing click for a held job
POST /watches               watch a repo: {"owner", "repo", "label"? (agent-review)}
GET  /watches               list watches
DELETE /watches/<id>        stop watching
POST /clusters/<id>/verdict a human verdict: {"verdict": "confirmed"|"refuted", "rationale"}
```

Jobs end `succeeded` (an empty diff included — nothing was owed a review),
`aborted` (turn cap, or a campaign stopped by unusable rounds), or `failed` (the error is stored on the
job). Shutdown is graceful: SIGINT/SIGTERM stops the poller and the claim
loop, lets the in-flight job finish recording (its credit is already spent),
then closes the stores; a second signal abandons the job. A job found
`running` at startup was interrupted and is marked failed — never silently
re-run; re-enqueue it deliberately. After a review
with findings, the worker proposes a held verify job for the target — the
release is the human's call.

**Watches are the trigger.** Every `--poll-interval` (default 300s) the
server lists each watched repo's open PRs and enqueues one *held* review job
per non-draft PR that carries the trigger label and whose head SHA has no
job yet, with the PR title riding along as reviewer context. Costs are
opt-in twice over: labeling the PR proposes, releasing the job bills. A head
SHA with any existing job — succeeded, failed, or cancelled — is never
re-enqueued by automation; at most 5 jobs enqueue per cycle, so a fresh
watch on a label-heavy repo trickles in instead of billing its backlog at
once.

### `npm run db`

```
npm run db -- merge <source.db>
```

Folds another machine's review database into `data/reviews.db` — for moving
work between machines that never run at once. No model calls. Stop `serve`
first. The target is backed up before the merge, which runs in one
transaction: rows from the source get fresh ids with every reference
rewritten, rows both files already share are matched rather than duplicated,
and copies that diverged inside one row's lifetime make the merge refuse
with the target unchanged.

## Eval

Regression harness for the clustering judge, separate from `npm test`
because the judge is stochastic.

```
npm run eval:freeze -- <consolidation-id>
npm run eval:judge [-- --trials N]
```

`eval:freeze` snapshots a human-verified consolidation into `eval/fixtures/`
(gitignored — finding text contains repo internals, so a fresh clone must
freeze its own) as the judge's golden set. `eval:judge` replays it through
the judge `--trials` times (default 1; each trial bills a judge call, and
back-to-back trials ride the prompt cache), scoring each partition against
the frozen answer by co-membership pairs. The summary reports the exact-match
pass rate with mean pair precision/recall, and every miss prints its
split-apart / falsely-lumped pairs — a sub-perfect rate is a signal to
inspect, not a hard failure.
