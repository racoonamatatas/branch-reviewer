# NOTES.md — project state across machines

Canonical store of project state, roadmap, and settled decisions, so a session
on any machine starts with full context. **Update this file whenever a slice
ships or a design decision lands** — it replaces machine-local session memory
as the source of truth. Keep raw finding text and target-repo code internals
out of it (same rule as `data/` and `eval/fixtures/`, which stay local); the
finding *labels* used below are fine.

## Status (2026-08-11)

Slices 1–10 shipped. **Slice 10 (Vue TS dashboard) complete** — read API,
Vue scaffold, mission control view + fixture server, blueprint view, static
serving from the job server. Next up per the roadmap below: deploy.

Slice-10 decisions (user-picked from four design prototypes): two views —
mission control as home (dark ops screen: queue, watches, targets, actions),
and a per-target "blueprint" view shaped like the pipeline itself (review →
consolidate → verify → coverage as one sheet, campaigns drawn as the loop
around stages 1–2). Calm/minimal and editorial directions were rejected —
schematic, information-dense surfaces win. Human-verdict write path is
flagged but deliberately out of scope (first write endpoint = its own
decision). The approved blueprint mockup is committed at
`docs/prototypes/blueprint.html` — chunk 4 implements that sheet.

Slice-10 build notes so far: `dashboard/` is its own Vite+Vue3 strict-TS app;
server types cross as `import type` via the `@server` alias and every response
schema carries `satisfies z.ZodType<ServerType>` so API drift is a compile
error (`dashboard/src/api/schemas.ts`); ids brand during parse with the real
`toTypedId`. `npm run dashboard:fixture` boots the HTTP surface over :memory:
stores — no worker, no trigger, no credit — for UI work
(`scripts/fixture-server.ts`); pair with `npm run dashboard:dev`. Casual
`npm run serve` is NOT safe for UI dev: the standing watch polls immediately.
Promote-to-campaign is cancel-then-enqueue so the 409 on a just-started
review stops a duplicate campaign. Live worker feed deferred — needs an SSE
transport; `usePolling` is the seam it replaces.

Chunk-4 (blueprint view) decisions: a "rev" is a consolidation — the picker
switches whole partitions (clusters are one judge call's opinion, they don't
compose across revs), follows the latest until the user pins an older one,
and details cache forever because consolidation rows are immutable.
`RunSummary` gained `turns` (the sheet's run lines need it; the `satisfies`
guard forced the dashboard schema in the same change). The campaign loop
band is **derived, not stored**: per-run novelty = clusters whose members
all come from that run, computed inside the displayed partition (same
definition as `novelClusters`, retrospectively); the stamp is the campaign
job's state because `stoppedBy` is never persisted. The coverage margin calc
mirrors `coverageOf`'s two branches — displaying f₁²/2f₂ when f₂ = 0 showed
division by zero on the fixture. Write actions without endpoints (verify
now, human stamps) render disabled with a note, keeping the approved mockup's
shape while the first write endpoint stays its own decision. Verified against
the fixture server with headless Firefox via geckodriver + raw WebDriver curl
(snap Firefox single-instance blocks `--headless --screenshot` while the
desktop browser runs; geckodriver sidesteps it).

Chunk-5 (static serving) decisions: `serveStatic` (`src/server/static.ts`)
hangs off `ServerDeps.staticRoot` — API routes always win, unknown GETs fall
through to the dist tree, and `npm run serve` enables it only when
`dashboard/dist/index.html` exists (API-only with a build hint otherwise), so
the same-origin paths the Vite dev proxy fakes are real in production. The
SPA fallback is deliberately extension-blind outside `/assets/` because
client routes embed branch names and those contain dots (`release/v1.2`); a
miss under `/assets/` stays 404 so a broken build can't feed HTML to a
script tag. Traversal has two layers: the WHATWG URL parse in `route()`
collapses `../` and `%2e%2e/` before the handler sees them, and the
handler's own decode-then-prefix check catches what survives (`..%2f`) —
the test exercises both via raw `node:http` requests, since `fetch`
normalizes traversals away client-side and never sends them. Vite's hashed
`/assets/` serve immutable cache headers; `index.html` is no-cache.

Remaining roadmap (sequencing user-confirmed): Vue TS dashboard (last,
standing decision) → deploy (webhooks may replace polling then; needs server
auth first). Eventually: read→write promotion (posting findings to PRs)
— a deliberate, separately-decided step with its own risk profile, not a drift.

Shipped so far:

1. Reviewer — schema, GitHub client (ported verbatim from branch-reviewer-api),
   three read tools as in-process MCP, `query()` runner, CLI (2026-08-05).
2. Cache-aware token accounting, observational only (2026-08-05).
3. SQLite run history, `node:sqlite`, findings relational (2026-08-05).
4. Cross-run consolidation — tool-less clustering judge, validated partition
   (2026-08-05; renamed merge→consolidate the same day, "merge" is reserved
   for git semantics).
5. Verification agent — adversarial, three-valued verdict (2026-08-06).
6. Campaign — adaptive rounds + coverage estimate + chained verify (2026-08-06).
7. Headless auth — `CLAUDE_CODE_OAUTH_TOKEN`, unauthenticated-result
   translation, `ANTHROPIC_AUTH_TOKEN` refused (2026-08-06).
8. Node server + job model — durable job queue in SQLite, sequential worker,
   four-route HTTP surface on `node:http`, localhost only (2026-08-07).
9. Trigger automation — label-gated PR polling: watches + `pollOnce`,
   SHA-keyed dedupe, per-cycle cost fuse, poll loop in serve (2026-08-07).

## Standing design decisions (don't re-derive)

- **Recurrence and importance are independent axes.** Union everything,
  adversarially verify occurrence-1 findings, recurrence counts are confidence
  badges — never a filter. (Proven: the project's best finding was a
  first-appearance singleton in run 4 of the same diff.)
- **Finding identity is semantic, not key-based.** Same defect recurs with
  different wording/angle/line anchors; (file, line, title) keys are dead on
  arrival. Hence the LLM clustering judge.
- **Verdicts are three-valued: confirmed / refuted / undetermined.** Refuted
  requires positive contrary evidence in the repo; absence of support is
  undetermined ("needs human eyes"), never refuted. A binary verifier launders
  its blind spots as verdicts.
- **Capture-recapture stopping rule.** f1/f2 (once-seen/twice-seen clusters)
  estimate undiscovered findings; campaign rounds continue until barren rounds
  exhaust patience. The estimate is reported, not gating — on real data it stays
  high for many rounds, so gating on it would mean never stopping before the run
  cap. Single run = cheap sample; union + verify = the trustworthy artifact.
- **Batch runs within the cache window.** Back-to-back runs of one target ride
  each other's prompt cache (fresh input drops to ~40–1,800 tokens against
  1.4–1.8M cache reads); campaigns fire rounds in one process, never spread
  over days.
- **Accounting and persistence are observational, never gating.** Save failures
  warn; usage numbers are reported, not acted on.
- **Server-slice error taxonomy (locked):** transient (529/network → retry),
  terminal (auth, bad branch → fail fast), capped (maxTurns → abort path). The
  runner's stream-error-with-captured-result split already provides the
  mechanics: with result = capped, without = retry candidate.
- **Subscription credit only.** `assertSubscriptionCredit()` refuses to run if
  `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set (credential precedence
  is undocumented; both are non-subscription billing paths).
  `CLAUDE_CODE_OAUTH_TOKEN` is the deliberate exception — subscription credit
  by construction, and the headless-auth path.
- **Claude-native on purpose.** Cross-provider abstraction stays in
  branch-reviewer-api; this rebuild surfaces model choice per run instead
  (`REVIEW_MODEL`, per-query model string).
- **Dashboard live cost asymmetry (for the dashboard slice):** stream-side
  input/cache figures reconcile exactly; per-message output_tokens is an
  at-start snapshot (lower bound). Live output needs `includePartialMessages`
  / message_delta cumulative output_tokens. Revalidate against the pinned SDK
  version when built.

## Empirical results worth not re-deriving

- **`num_turns` = round-trips, not tool calls.** On clean runs it comes out as
  tool calls + 2 (initial prompt + final answer); parallel tool blocks share a
  turn. An aborted run reports exactly maxTurns + 1. One run reported 32 turns
  under a cap of 20 without aborting — and the slice-8 acceptance run answered
  the open question: it finished at 43 turns under a cap of 40 with **zero**
  compactions, so compaction-resets-the-budget is dead. `num_turns` and the
  maxTurns budget simply count different things; treat the cap as approximate
  and size it with headroom.
- **Verifier calibration: 8/8 defensible** on the canonical queue
  (consolidation #3 in the local DB). The one case with a "known real"
  expectation came back refuted, and *the refutation held* across three
  independent passes — the expectation itself was stale. Lesson: ground truth
  can be wrong; a verdict is only as good as the evidence it cites.
- **Verify cost ≈ 30% of a review run** (~$0.81 vs ~$2.64). One finding whose
  evidence crossed from backend to frontend needed `--max-turns 24` against the
  verifier's default of 12.
- **Verdict instability traces to search coverage, not judgment** — fixed by
  prompt (`017de66`): check deploy/env config where overrides actually live,
  and name every conditional guard crossed on a cited path.
- **Verdict inheritance by member set** (`645e48a`): a new consolidation whose
  cluster has an identical member set inherits the latest verdict instead of
  triggering paid re-verification (a 3-round campaign once re-spent ~$5 on
  already-adjudicated findings); `--reverify` re-tests deliberately.
- **Judge stability is good:** independent re-clusterings of the same four runs
  produced identical partitions — which is what makes f1/f2 trustworthy.
- **The well was still not dry after 6 reviews** of the reference target: the
  estimator put ~11 findings undiscovered of ~26 total, with marginal yield
  steady at ~1 novel finding per run.

## Slice log — discoveries worth keeping

Per-slice detail that the condensed list above loses. Harness behavior, not
target detail.

**Slice 1 (reviewer).** `tools: []` denies *all* built-ins and is cleaner than
enumerating `disallowedTools`; `permissionMode: 'dontAsk'`; `outputFormat:
json_schema` replaces the predecessor's `submit_review` tool entirely (the
harness collects and validates the final answer). Tool names and schemas are
deliberately identical to branch-reviewer-api so differences between the two
reviewers are attributable to the harness alone — SDK-native `outputFormat` is
the one documented divergence. **SDK wart:** a heterogeneous array of `tool()`
results won't type as `SdkMcpToolDefinition<any>` (handler args are
contravariant), hence the erased `RegisteredTool` shape in `src/tools/tools.ts`.

**Slice 2 (accounting).** Input-side fields reconcile to exactly zero against
the result totals, but per-message `output_tokens` is an **at-start snapshot**,
so the streamed output sum is a lower bound — dashboards must treat it as one.
`UsageAccumulator` keys by API message id because parallel tool calls share an
id and naive summation double-counts. **After an error result the SDK stream
yields the result message and then throws** ("Claude Code returned an error
result: …"); the runner catches, keeps the result (it carries turns and usage),
and rethrows only if no result was ever seen.

**Slice 3 (history).** `node:sqlite` means zero new dependencies (needs Node
≥ 24). `cli.ts` must never be imported — its `main()` runs at module top level
— which is why the renderers live in `src/cli/render.ts`, shared with the other
entry points. Aborted runs persist with their stats; `--no-save` opts out.

**Slice 4 (consolidation).** The clustering judge is the harness degrading
gracefully into plain structured inference: no MCP servers, `tools: []`,
`maxTurns: 1`, pure `outputFormat`. The judge proposes the partition,
`validatePartition` enforces it (one retry with the violation named). Findings
are immutable and clusters derived, so re-consolidating writes a new row rather
than mutating. Naming: **"merge" is reserved for git semantics** (merge base) —
the feature is "consolidate" everywhere, and legacy DBs migrate in place on
open. "Singleton" is avoided in favor of occurrence phrasing ("seen in 1/N").

**Slice 5 (verify).** Verdicts are first-class append-only rows, so improving
the prompt and re-running never overwrites history; `clusters.verification_status`
reflects the latest verdict and its vocabulary includes `undetermined`. What
makes the prompt work is stated as method, not vibes: check where overrides
actually live (deploy manifests and environment templates, not just application
config) before concluding a setting is unpinned, and follow every conditional
guarding a cited path and name it in the rationale.

**Slice 6 (campaign).** Rounds fire back-to-back in one process to ride the
prompt cache; each round re-consolidates every stored run of the target, so
novel-cluster counts are measured *inside* one partition (comparing cluster
counts between rounds would measure the judge, not the branch). Two consecutive
aborts stop the campaign — structural, not worth burning the run cap on.

**Slice 7 (headless auth).** `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`
in `.env`; the SDK reads it straight from env (v0.3.222), so the existing
`--env-file-if-exists` wiring was already enough. **The unauthenticated
failure shape is a wart worth knowing:** the result message arrives with
`subtype: 'success'` but `is_error: true` (zero cost, `result: "Not logged in
· Please run /login"`), then the stream throws — the success/error split in
`subtype` does not cover it, and consolidate's judge would have died on a Zod
parse of the absent `structured_output`. `throwIfErrorResult()` (shared from
review.ts, called by all three query() consumers) translates it and points
headless machines at `claude setup-token` instead of the SDK's `/login`
advice. `assertSubscriptionCredit()` now also refuses `ANTHROPIC_AUTH_TOKEN`
(same SDK credential list as the API key; a gateway/proxy billing path) —
`CLAUDE_CODE_OAUTH_TOKEN` is the one deliberate exception, minted against the
subscription itself. `claude setup-token` is interactive (browser OAuth
flow) — it cannot run inside a harness session; use a real terminal.
Acceptance passed 2026-08-06: full review completed and saved with `HOME`
pointed at an empty temp dir (no login visible) and only `.env` credentials —
run #9, a public fastify PR, $1.28, 10 findings. A fine-grained GitHub PAT
authenticates while org approval is still pending (approval gates the org
repo, not the token), so public-repo targets work immediately.

**Slice 8 (server + job model).** Three chunks: job store, worker, HTTP
surface. Jobs live in the same SQLite file as the runs they produce; states
move queued → running → succeeded | aborted | failed (queued → cancelled
before work starts), every transition guarded by its expected prior state.
The worker is sequential on purpose — subscription credit is a serial
resource and back-to-back runs of one target ride each other's prompt cache —
and drains chain (`tail.then(drain)`) so a job enqueued in the race window
between the last empty claim and the drain resolving is still picked up.
Outcome mapping follows the locked taxonomy: submitted → succeeded, capped →
aborted (run still saved), throw → failed with the error stored; a campaign's
`no-usable-runs` aborts, `dry`/`max-runs` both succeed. Deliberate CLI
divergence: a failed save fails a job (its result is reachable only through
the store), where the CLI save is observational. A job found `running` at
startup is marked failed, never silently re-run — a re-run bills credit,
which is a human decision. HTTP: four routes hand-rolled on `node:http`
(four routes don't earn a framework), request-level policy in the request
schema (Zod `.prefault({})` runs the fallback through the schema so inner
defaults apply), 404 vs 409 distinguished on cancel via the store's state
guard. Both stores now set `PRAGMA busy_timeout = 5000` — the server is the
first thing to put two connections on one file. Localhost only; exposure is
the trigger slice's decision. No graceful shutdown: Ctrl-C kills an
in-flight query() and recovery marks it failed next start.
Acceptance passed 2026-08-07 on the reference target: review job enqueued
over HTTP, 42 tool events streamed against the job id, job succeeded in
6m50s → run #9 (submitted, 8 findings, 43 turns, $4.01), readable via
`npm run history` and indistinguishable from a CLI run. The same run
finished over-cap with zero compactions — see the num_turns bullet above.

**Slice 9 (trigger automation).** Polling, not webhooks — webhooks need
inbound exposure and server auth, both deploy-slice concerns; polling works
behind NAT with the existing token and the job model doesn't care which one
feeds it. Label-gated (user-decided): only open non-draft PRs carrying the
watch's trigger label (default `agent-review`) are reviewed, one review job
per head SHA — cost is opt-in twice over (label = the request, each push =
new SHA re-triggers only while labeled). The jobs table is the trigger's
memory: `hasJobFor(owner, repo, head)` in any state blocks re-enqueue, so a
failed job is never auto-retried and a human's cancel is never overridden;
there is no separate seen-SHAs table to drift. Head is pinned to the SHA,
not the branch name — the job reviews exactly the state that carried the
label. Cost fuse: at most 5 enqueues per poll cycle across all watches, the
rest deferred and counted. Watches live in a DB table (a committed config
file would leak target identity). `PullSource` is a separate interface so
`RepoClient` stays the verbatim port from branch-reviewer-api. The serve
poll loop skips overlapping passes (two concurrent passes could both see a
SHA as unseen and double-enqueue). Acceptance: free-path proven live —
watch on a busy public repo (79 open PRs, none labeled) enqueued nothing
across cycles, and an unreachable-repo watch printed its 404 per cycle
while other watches kept polling. Paid end-to-end passed 2026-08-07 on this
repo's own PR #1: label applied → job auto-enqueued on the next 30s cycle
with head pinned to the PR SHA → run #10 (submitted, 1 finding, 6 turns,
$0.32) → the following cycle skipped the SHA (no duplicate). The finding
was a defensible nit on the PR's own refactor — an unconstrained generic
that would let unbranded ids past the checking-constructor convention —
citing toTypedId as the standard to match.

**Standards to hold, not regress.** (1) The judge has a golden fixture and
`npm run eval:judge` replays it — every clustering-prompt edit gets checked
against it. (2) `read_file`'s description earns its keep: the project's best
finding rested on three pieces of evidence *outside* the diff hunk (a sibling
guard, an adjacent cast, and why static analysis was blind to it). When tuning
tool descriptions, that finding is the bar.

Personal working preferences (question pacing, slice discipline, strictness
taste) live in the user's own `~/.claude/CLAUDE.md`, deliberately not committed
here.

## Open items

- "Needs human eyes" has no answer path — a human-verdict row on top of agent
  verdicts (append-only makes overrule natural).
- Server has no graceful shutdown — an in-flight run dies with the process
  (credit spent, result lost) and is marked failed on next start. Fine while
  local; revisit before deploy.
- Server has no auth of its own — safe only because it binds 127.0.0.1;
  auth must land before any exposure (deploy slice, where webhooks may also
  replace polling).
- A standing watch exists on this repo (label `agent-review`): any labeled
  PR gets auto-reviewed whenever the server runs. Deliberate — remove via
  DELETE /watches if unwanted.
- **Decide: loop-band novelty stays derived, or `RoundOutcome` gets
  persisted.** Chunk 4 derives per-run novelty in the browser from the
  displayed partition (and shows the campaign job's state because `stoppedBy`
  is not stored either). Derivation is always consistent with the rev on
  screen but anachronistic — a newer judge call can merge away a round's
  novel cluster, so the sheet can't answer "what did the campaign see when
  it decided to stop". Storing rounds buys that history at the cost of a
  migration, a write path, API surface, and a second copy of truth. Current
  lean: keep deriving until a real consumer of as-it-happened rounds shows
  up; either way, the dashboard's re-implementation of `novelClusters`
  should become a value import from the pure coverage module.
- Judge golden set is a single fixture — grow it as human-verified
  consolidations accumulate (`npm run eval:freeze`).
- Learning-surface backlog (piggyback on future slices): submit_review-parity
  experiment, hooks, compaction experiments, subagents, streaming input,
  session persistence.

## Reference target

All calibration and cost numbers above come from replaying one already-merged
PR on a private work repo, by SHA (base = the merge commit's first parent), so
results are comparable across slices. The target is not named here and its
findings are not quoted: runs, consolidations, and verdicts live only in
`data/reviews.db` (gitignored; moved between machines as an age-encrypted copy,
never committed). Same rule for `eval/fixtures/`.
