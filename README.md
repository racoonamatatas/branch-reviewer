# branch-reviewer-sdk

An agentic code-review pipeline built on the Claude Agent SDK, designed
around one empirical observation: **a single LLM review of a branch is a
sample, not a survey.** Six reviews of the same branch produced six
overlapping-but-different finding sets — the fourth run contributed the best
finding of the project. So this tool doesn't try to make one review better;
it makes many reviews composable: sample repeatedly, merge what recurs,
adversarially test what doesn't, and account for every dollar spent doing it.

Read-and-report only: it reviews a GitHub branch against its merge base and
reports structured findings. No editing, no fixing. Fresh-start successor to
[branch-reviewer-api](https://github.com/racoonamatatas/branch-reviewer-api),
which hand-rolls the same agent loop against the raw Messages API — kept as
the comparison baseline, so the two projects differ only in harness.

## The thesis

If runs are samples, three things follow, and each is a pipeline stage:

1. **The union is the artifact.** Findings from every run of a target are
   stored relationally and *consolidated*: a one-turn, tool-less judge call
   proposes which findings across runs describe the same underlying defect
   ("two findings belong together only if fixing one would fix the other").
   The model proposes the partition; our code validates it exhaustively —
   every id known, every id exactly once, representatives members of their
   own clusters. Recurrence across runs becomes an `occurrence` count per
   defect.

2. **Recall belongs to the sampler, precision to the pipeline.** The
   reviewer's prompt says so explicitly: report every genuine suspicion,
   state a `confidence` (low/medium/high), and let downstream filtering
   decide — a finding withheld is gone for good, a wrong finding is caught
   later. The catcher is the *verifier*: one agent per queued finding, same
   read-only tools as the reviewer, prompted to settle the claim with equal
   effort in both directions. Its verdict is deliberately three-valued —
   `confirmed` / `refuted` / `undetermined` — because "couldn't refute" and
   "refuted" are different facts: refutation requires positive contrary
   evidence in the repo, and evidence that lives outside the repo (runtime
   behavior, deploy config, team intent) surfaces as `undetermined` and goes
   to a human.

3. **"How many more runs?" is answerable.** The campaign loop reviews one
   target repeatedly (rounds ride each other's prompt cache), re-consolidates
   after every round, and stops when rounds stop yielding novel defects —
   with a capture-recapture estimate (Chao1 over occurrence counts) reported
   alongside as an *optimistic ceiling* on what remains unseen. See
   [design boundaries](#design-boundaries-and-next-experiments) for why it's
   a ceiling and why it never gates the loop.

4. **Diversity is designed, not hoped for.** Building the estimator exposed
   the deepest problem with repeated sampling, and it wasn't cost — it was
   correlation. Identically-prompted rounds of the same model walk the same
   files in the same order and miss the same things: Chao1's independence
   assumption breaks, and recurrence inflates into false confidence (the
   errors a correlated ensemble repeats most consistently are its systematic
   ones). So campaign rounds are rotated apart: a reviewer *lens* cycles
   per round (generalist first, then security → concurrency →
   config-and-deploy → tests — each redirects where the round looks first,
   never what it may report), and the review model can cycle too
   (`--models a,b`), which upgrades an occurrence count from "one model
   repeating itself" to **cross-model agreement**. Both are recorded on
   every run, so the union knows which lens and which model saw what.

Verdicts are earned by *defects*, not by cluster rows: they inherit across
re-clusterings by exact member set, and when a re-clustering merges an
adjudicated group with new reports, the lapsed verdict is recorded and the
merged cluster re-enters the verification queue with that verdict as
context — a refuted finding can neither resurrect silently nor hide from
re-testing.

## Cost posture

Everything that calls a model bills real subscription credit, so the
pipeline treats money as a first-class output:

- **Subscription credit only.** Every model-calling path refuses to start if
  `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set — a run can never
  silently bill pay-as-you-go. Headless machines use a
  `CLAUDE_CODE_OAUTH_TOKEN` minted by `claude setup-token`, which is
  subscription credit by construction.
- **Every role is metered.** Review runs, clustering judge calls (retries
  included), and verification agents all record their cost; a campaign's
  summary itemizes reviews / judge / verification, and per-target totals
  aggregate all three.
- **One model per role.** The reviewer and verifier do evidence work and
  default to Opus; the clustering judge solves a matching problem over short
  texts and defaults to Sonnet. `REVIEW_MODEL` / `JUDGE_MODEL` /
  `VERIFY_MODEL` override each independently (`REVIEW_MODELS` opts campaigns
  into per-round rotation), and no call ever falls through to an SDK
  default.
- **Automation proposes, humans dispose.** PR-label triggers and
  post-review verification proposals enqueue jobs *held* — releasing one is
  the explicit billing click. An empty diff aborts a review before any
  credit moves. The server requires `application/json` and a loopback `Host`
  so a hostile web page can't spend credit through the browser.

## Architecture

Pipeline stages, each a directory under `src/`, tests mirroring under
`test/`:

```
review      one query() per branch review; 4 in-process MCP read tools
            (list_changed_files, get_diff, read_file, list_files) over the
            GitHub API; structured output via outputFormat: json_schema
store       run history on node:sqlite; findings are relational rows because
            cross-run comparison queries them; append-only verifications
consolidate the clustering judge + partition validation + persistence;
            degrades to the identity partition after retry exhaustion
verify      the settlement agent, the verification queue, verdict
            inheritance and lapsed-verdict re-testing
coverage    Chao1 estimator + the barren-rounds stopping rule + the
            refuted-clusters filter, pure and structurally typed
campaign    the loop: rotate lens/model → review → consolidate → measure
            novelty → stop on patience or two consecutive unusable rounds
            → verify pending
server      durable job queue (guarded state machine), one sequential
            worker with injectable runners, hand-rolled node:http surface
trigger     label-gated PR polling; enqueues held review jobs with the PR
            title as reviewer context; per-cycle cap as the cost fuse
dashboard   Vue 3 mission-control over the same API; server types imported
            via an alias so API drift fails the build
```

Trust boundaries are explicit. Model-authored output never enters the system
unvalidated: review findings parse through Zod schemas, judge-proposed
finding ids (the least-trusted numbers in the system) gain their branded
types during parse, the partition is validated before persistence, and
SQLite foreign keys backstop the lot. Ids are branded number types with
exactly one cast in the codebase; entity create-shapes derive from entities
by subtraction (`New<T>`), a relationship the test suite asserts at compile
time.

Failure design follows one rule: **paid work survives its own failures.** A
judge outage mid-campaign records the round and keeps the summary; a save
failure never changes a review's outcome; a crashed job is marked failed at
startup and never silently re-run; the worker's drain chain survives its own
rethrows. Sequential on purpose — back-to-back runs of one target share a
prompt cache, so parallelism would cost more, not less.

## What the tests cover

`npm test` (fast, no network, no model calls) runs ~260 tests: the store
against real in-memory SQLite including migration tests on hand-built legacy
databases, the HTTP surface over real sockets (including path-traversal and
Host-spoofing attempts that `fetch` would normalize away), the job state
machine's every transition guard, and — via injectable stage runners — the
paths that decide when credit burns: campaign stopping rules, judge-failure
salvage, the verification reuse gate, and record-and-continue verdict
persistence. The SDK itself is mocked only at the judge's seam; nothing in
the unit suite spends credit.

The clustering judge has its own regression harness (`eval/`), separate from
the unit suite because the judge is stochastic. `eval:freeze` snapshots a
human-verified consolidation as a golden set; `eval:judge --trials N`
replays it N times and reports a pass rate with *co-membership pair*
precision/recall (which findings ended up together) — the right metrics for
a stochastic partitioner, where one exact-match trial is a coin flip — and
prints split-apart / falsely-lumped diffs on every miss. A sub-perfect rate
is a signal to inspect, not a hard fact.

## Design boundaries and next experiments

Each boundary is owned here with the direction it points, rather than
discovered later:

- **Rotation reduces correlation; it does not prove independence.** Lens and
  model rotation exist because identical rounds broke Chao1's assumptions
  (see thesis §4), but rotated rounds still read the same diff with
  overlapping instructions, so every surface keeps labeling the estimate
  "at most ~N unseen (optimistic ceiling)" and the stopping rule stays
  barren rounds, never the estimate. *Next experiment:* re-run the reference
  target with a two-model roster and compare its singleton/doubleton curve
  against the recorded single-model campaigns — the per-run `lens` and
  `model` columns exist so that comparison is a query, not archaeology.
- **Occurrence under a single model is still self-agreement.** Findings seen
  twice skip adversarial verification by default, which is only as sound as
  the samples are independent; with one model in the roster, "seen twice"
  can mean "systematically claimed twice". `--models` is the fix when spend
  allows; `--reverify` re-tests deliberately either way. *Next experiment:*
  compare verification outcomes of occurrence-≥2 clusters sampled
  cross-model versus same-model — cross-model recurrence should survive
  verification at a measurably higher rate.
- **The judge eval is one fixture deep.** `eval:judge --trials N` turned the
  verdict from a coin flip into a pass rate with pair precision/recall, but
  a rate against a single golden set still measures one clustering problem.
  It grows by accretion: every human-verified consolidation is a candidate
  `eval:freeze`. *Next:* freeze the second fixture, then make the eval walk
  all of them.
- **The verifier has no eval, and its verdict is the highest-stakes model
  output in the system.** The ground truth it needs is accumulating on its
  own: human verdicts are append-only rows that overrule agent verdicts, so
  every overrule is a labeled disagreement. *The sketch:* when enough exist,
  replay adjudicated clusters through the verifier and score verdict
  agreement against the human labels — same freeze-and-replay shape as the
  judge eval. Deliberately not built at n≈dozens; the harness would outweigh
  its dataset.
- **The server is a localhost tool, by decision.** No auth, no TLS: it binds
  127.0.0.1 and treats exposure as a separate slice with its own risk
  profile (auth lands first, webhooks may replace polling). The
  browser-facing hardening exists now (content-type gate, loopback Host
  allowlist, generic 500s), and shutdown is graceful — SIGINT/SIGTERM stops
  claiming, lets the in-flight job record its outcome, then closes the
  stores; a second signal abandons the job to startup recovery.

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
- `REVIEW_MODEL` — reviewer model, default `claude-opus-5`.
- `REVIEW_MODELS` — comma list; campaigns rotate the review model per round.
- `JUDGE_MODEL` — clustering judge, default `claude-sonnet-5`.
- `VERIFY_MODEL` — verifier, defaults to the reviewer's model.

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
and exits 0 (clean), 1 (a critical finding), or 2 (aborted — turn cap or an
empty diff). Saved to run history unless `--no-save`.

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
consolidation (judge cost included). Runs must target the same
owner/repo/head/base and each must have a completed review. No args lists
stored consolidations; `--show` reprints a saved one.

### `npm run verify`

```
npm run verify -- <consolidation-id> [--max-turns N] [--reverify]
```

Adjudicates the consolidation's pending queue — occurrence-1 clusters, plus
clusters whose members absorbed a previously-adjudicated set — one
settlement agent per cluster. `--reverify` re-tests clusters that already
have a verdict. Reprints the consolidation with verdicts attached.

### `npm run campaign`

```
npm run campaign -- <owner>/<repo> <branch> [--base main] [--max-runs N] [--patience K] [--max-turns N] [--no-verify] [--reverify] [--models a,b] [--no-lenses]
```

Repeats review rounds on one target until discovery dries up (`--patience`
rounds in a row with no new finding, default 2), the run cap is hit
(`--max-runs`, default 3), or two consecutive rounds are unusable.
Consolidates after every round; verifies the pending queue at the end unless
`--no-verify`. The summary itemizes review, judge, and verification spend.

Rounds are diversity-sampled by default: round 1 reviews generalist (the
comparable baseline), later rounds cycle a lens — security, concurrency,
config-and-deploy, tests — that redirects attention without narrowing what
may be reported (`--no-lenses` disables). `--models a,b` additionally cycles
the review model per round, making recurrence cross-model agreement; it
deliberately trades away cross-round cache sharing, because cache-warm
repetition is the correlation being removed. Lens and model are recorded on
each run.

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

Jobs end `succeeded`, `aborted` (turn cap, empty diff, or a campaign with
two consecutive unusable rounds), or `failed` (the error is stored on the
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
