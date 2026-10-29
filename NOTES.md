# NOTES.md — project state across machines

Canonical store of project state, roadmap, and settled decisions, so a session
on any machine starts with full context. **Update this file whenever a slice
ships or a design decision lands** — it replaces machine-local session memory
as the source of truth. Keep raw finding text and target-repo code internals
out of it (same rule as `data/` and `eval/fixtures/`, which stay local); the
finding *labels* used below are fine.

## Status (2026-08-20)

Slices 1–13 shipped. **Slice 12 (persist campaigns)** — campaigns are
first-class stored entities written by both the CLI and the worker, served
over HTTP, and the dashboard loop band keys on them. **Slice 13 (campaign
liveness leases)** — abandoned running rows are proven dead by a kernel-
released SQLite lock and swept, closing slice 12's SIGKILL hole (see
below). Next, per the roadmap: deploy.

**Finishing pass (2026-08-14):** four slices shipped in one day — A
(correctness: drain chain, judge-failure salvage, POST hardening), B (thesis
fixes: recall-first prompt + finding confidence, list_files, symmetric
verifier, lapsed verdicts, judge metering, per-role models), C (src/sdk/
extraction, injectable stage runners, money-path tests, dead-weight
deletion), D (README as the portfolio artifact). **Diversity sampling**
landed next (same day): campaigns rotate a per-round reviewer lens
(generalist → security → concurrency → config-and-deploy → tests, on by
default, `--no-lenses` to disable; `src/review/lenses.ts`) and optionally
cycle the review model per round (`--models a,b` or `REVIEW_MODELS`),
converting Chao1's broken independence assumption into a designed ensemble —
occurrence becomes readable as cross-model agreement. The lens rides the
user prompt so the system prompt stays the shared cache prefix; lens and
resolved model are recorded on the run (nullable `lens` column, resolved
model never saved as 'default' when rotating). Rotation picks the
least-sampled slot from the target's stored runs (see "Rotation resumes"
below; it was originally a function of round number alone); an aborted round
still consumes its slot. Model
rotation forfeits cross-model cache sharing on purpose — purely a cost, not
a statistical loss: the sameness of the inputs is the correlation, and a
cache hit only certifies that sameness (identical prefixes compute
identically, cached or not). Worker campaign jobs keep a
single model (params carry one); a job-level roster is a later decision.
The rest of the finishing plan landed the same day: **graceful shutdown**
(`Worker.stop()` stops claiming and resolves when the in-flight job has
recorded; serve traps SIGINT/SIGTERM — stop polling, close the listener,
await the worker, close stores; a second signal abandons the job to startup
recovery; under Ctrl-C the SDK subprocess shares the terminal's SIGINT and
may die first, which surfaces as the job failing through the normal catch —
recorded, not lost), **`eval:judge --trials N`** (sequential trials riding
the prompt cache; per-trial exact-match + pair precision/recall, summary
pass rate; exit 0 only on N/N, sub-perfect is a signal to inspect), and the
**README reframe** (correlated-sampling insight promoted to thesis §4 as
what motivated the rotation ensemble; "Known limitations" became "Design
boundaries and next experiments", each with a trajectory; verifier eval
stays a stated gap with the freeze-and-replay sketch over accumulated human
verdicts; localhost/no-auth stays a decision). **Smoke campaign ran 2026-08-14** (~$13.7 total) on this repo's own PR #4
(`finishing-pass`, 54 files): 3 rotated rounds (opus/generalist $3.05 → 10
findings, sonnet/security $1.03 → 3, opus/concurrency $3.29 → 11) → rev 14
(16 clusters, f1=10 f2=4, judge $0.06) → verify 10/10 occurrence-1 clusters
($6.24): 8 confirmed, 2 refuted with high-quality contrary evidence. The
smoke caught three pipeline bugs, all fixed same-day (`b4e4e1b`): the judge
had been dead since slice B (maxTurns: 1, but Sonnet returns structured
output in a second round-trip — every judge call aborted; cap now 4), and
the worker dropped both round failures and consolidation failures silently
(a campaign that consolidated nothing ended "succeeded" clean). Job #5 also
proved the .env fine-grained PAT does not cover this repo (404) — serve ran
with `gh auth token`. **Confirmed findings now queued as follow-ups** (see
open items): campaign-aware shutdown, VERIFY_MODEL on the server path,
baseline-failure reporting, usePolling guard; plus the unverified occ-3
CRITICAL (release/cancel routes lack the CSRF gate) and occ-3 PR-title
prompt-injection warning.

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

Chunk-6 (single-run visibility) decisions, user-driven ("before I tell
someone I found something, I want to know if it is real"): findings shown to
a human must carry verification state — a single-run finding is a claim, not
a fact, and the UI says so. `GET /runs/:id/findings` exposes a run's own
findings; the blueprint falls back to the latest submitted run's findings
when the target has no consolidation, each row stamped UNVERIFIED. The
callout takes a discriminated union (cluster | finding) rather than a fake
one-member cluster, so unverified claims can't borrow the verified path's
rendering. The start-campaign CTA moved out of the coverage gate — a one-run
target is exactly when a campaign is most wanted. The consolidate CLI now
accepts a single run (`< 2` guard relaxed): verification hangs off clusters,
so clustering one run is how its findings become verifiable — campaign
already produced single-run consolidations after round 1. The path is
proven: run #14 (a real PR on the target repo) consolidated alone and
verified 5/5 clusters — 4 confirmed, 1 undetermined ($3.26).

Chunk-7 (human verdicts — the first write endpoint, deliberately decided):
`Verification` is now a provenance union — `AgentVerification` (confidence,
costUsd) | `HumanVerification` (neither), enforced in SQL by a CHECK and in
TS by the discriminant; the verifications table was rebuilt in place
(`migrateVerificationProvenance`, prior rows become `agent`). `POST
/clusters/:id/verdict` takes `{ verdict: confirmed|refuted, rationale }` —
humans never stamp undetermined (that's the machine's "I don't know"; a
human who doesn't know abstains), and the rationale is required because
verdicts inherit across consolidations by member set and a bare stamp would
propagate with no trace of why. Appends only — overrule, never overwrite;
the endpoint is a named breach of "the worker owns every write", justified
because human judgment is the one write the worker cannot produce. Dashboard
stamps are live in the callout (rationale input gates the buttons); a stamp
invalidates that rev's forever-cache entry, which verification appends had
already quietly falsified. "Verify now" stays disabled until a verify job
kind exists (open item, with a consolidate job kind).

Chunk-9 (one page, user-decided): the two-view split is retired — mission
control's dark-ops theme is gone and the whole dashboard is one
blueprint-styled page. Tokens and primitives (`--sheet`/`--chalk`, `.stage`,
`.bp-btn`, title block) live once in `dashboard/src/blueprint.css`; the
per-target pipeline became `components/TargetSheet.vue`, expanding beneath
the mission-control grid instead of navigating away. The route is still the
selection — `/` and `/target/:owner/:repo/:head` render the same view, the
latter with the sheet open — so refresh/back/deep links survive (the
two-machine "send myself a link" habit). The sheet is keyed by target:
remount replaces the old view's hand-rolled eleven-ref reset. One poller for
the page: mission control owns the 3s cycle, the sheet gets jobs/watches as
props and exposes `refresh()` for its runs/consolidations; job actions
(cancel/promote/enqueue) emit up to the parent's `act()`, stamping stays in
the sheet. Queue panel shows active (queued+running, execution order) with
a recent tail capped at 8 — display filtered, ledger intact, because the
jobs table in any state is the trigger's idempotency memory and pruning it
would re-arm auto-enqueue for seen SHAs. Rendering gotchas worth keeping:
per-cell dashed `td` borders restart the dash pattern at every column (put
the border on `tr`); `display: flex` on a `td` un-table-cells it and breaks
border painting; the native `<option>` popup is OS-drawn and needs an
explicit dark background or it's white-on-white.

**Slice 11 (mission-control operations), in progress.** Chunk 1 — activity
feed + heartbeat, built because the live test left the user unable to tell
"working" from "frozen". `EventLog` (`src/server/events.ts`) is a ring of
200 in process memory, deliberately not a table: a liveness signal, not a
record — everything worth keeping is already a row elsewhere, and it dying
with the process is correct. `GET /events?after=seq` tails by cursor (the
3s dashboard poll usually carries zero events); a cursor from a previous
process life overlaps the new numbering and the client starts over instead
of appending — restart never looks like silence. `PollStatus` discriminates
`{ polling: false }` (fixture/tests have no poller — a different fact from
"hasn't polled yet"). serve tees every console line into the ring and adds
one line per poll pass even when quiet, because a quiet pass and a dead
poller must not look identical. Dashboard: activity panel (newest first,
bottom of mission control), header heartbeat (`poll Ns ago · every 300s` +
`updated HH:MM:SS`), chalk pulses on sheet stage heads while a target's job
runs (campaign pulses 01–03 — per-stage precision waits for job kinds).
Found in passing: the Vite dev proxy lacked `/clusters`, so human stamps
from the dev server had always been broken — only ever exercised via :4780.
Agreed next chunks: `held` job state (trigger enqueues held; form gets
Enqueue-held vs Start-now buttons; ▶ release transition), a verify job kind
auto-enqueued held after each review, coverage honesty (exclude refuted
clusters from the estimator, flag empty-diff runs).

Chunk 2 — `held`: the machine proposes, the human disposes. New first state
in the job machine (held → queued → running → …; held and queued both exit
to cancelled), chosen at the enqueue door (`enqueue(job, { held })`) rather
than by transition: whether work may bill without a further click is the
enqueuer's decision. The trigger enqueues held; POST /jobs defaults to held
with `start: true` as the explicit express lane (request policy, not stored);
POST /jobs/:id/release is the human "go" and the only place the worker gets
kicked for a formerly-held job. UI rule: the chalk ▶ is the only click that
bills, everywhere — the form's two doors (◌ enqueue held / ▶ start), the
queue's ▶ start on held rows, the sheet CTA (start: true, it *is* the click);
promote always parks the campaign held. No DB migration: state had no CHECK.
Adding 'held' to JobState made tsc sweep every Record<JobState, …> display
table — the discriminated-union payoff, working as intended. Chunk-1's diff
was itself reviewed via PR #3 (run 21, 5 findings, $0.91) and CLI-verified
5/5 confirmed ($2.73); all five fixed in this chunk: /events gained a `boot`
process-life id (seq comparison across restarts can be out-run; boot change
is unambiguous — client refetches whole, never appends across lives), feed
timestamps render local via a shared `clock()` (ISO slicing displayed UTC),
the feed fetch degrades independently of the queue fetch, ring-eviction gaps
render as explicit "N evicted" lines, and stage pulses key on kind per stage
so the future verify kind cannot light Review.

Chunks 3+4 — verify job kind and coverage honesty. `verifyTarget`
(src/verify/verify.ts) is the verify job's runner: consolidate the target's
submitted runs unless the latest rev already covers exactly that set
(verdicts inherit by member set, so a fresh judge call over the same runs
buys nothing), then `verifyPending`. The consolidation mechanics moved to
`src/consolidate/persist.ts` (`submittedRunsFor` + `consolidateRuns`),
shared with the campaign — campaign keeps its own `< 2` policy at the call
site. Worker: after a submitted review with findings, a **held** verify job
is auto-enqueued for the target (deduped via `hasOpenJobFor` — open means
held/queued/running; finished verify jobs don't block a later pass over new
runs). A verify job for a target with no submitted runs fails with a named
error; a target whose runs had no findings succeeds vacuously. UI: "verify
now" in the callout is live (whole-target, start: true — the chalk click is
the billing click), form gained the verify kind, stage pulses key by kind
per stage. Coverage honesty: refuted clusters are excluded from
`coverageOf`'s input at every call site (server detailOf, campaign baseline
and rounds) — a disproven claim is not a discovered finding — and the
margin calc says "N refuted excluded" so the fraction visibly adds up.
Empty-diff runs: `runReview` measures the compare before spending credit
(one extra GitHub request), runs store `files_changed` (nullable ADD COLUMN
migration; old rows stay NULL = "unknown", never zero), and the sheet's run
line says "empty diff — reviewed nothing" instead of presenting a review of
nothing as a clean bill of health (the trap R2/R3 fell into after PR #2
merged out from under campaign #9).

Chunk-9 live test (2026-08-11, ~$5.50): labeled PR #2 on this repo →
auto-enqueued review of the chunk-9 diff itself (run 18, 4 findings, $2.18)
→ CLI consolidate #11 → CLI verify (3 confirmed, 1 refuted, $3.26). The
verifier's refutation read the router config and vue-router 4 semantics to
prove the claimed rejection impossible — three-valued verdicts earning
their keep. The test caught three display bugs the fixture never could
(connector/desc labels were rev-derived while the body showed the
no-consolidation fallback; the detail forever-cache went stale on screen
when CLI verify appended verdicts — details now refetch each poll cycle,
the cache only smooths rev switches). All three confirmed findings fixed;
sheet no longer self-fetches on mount (parent's first tick or the
target-switch watcher fills it). Stage titles are fixed station names on
purpose — the desc/body carry the data state. UI still can't consolidate
or verify; that's the job-kinds open item, now user-felt.

**Slice 12 (persist campaigns).** The fix for "CLI campaigns are invisible
as campaigns", and the decision the loop-band open item was waiting on:
`RoundOutcome` is persisted. Chunk 1: a campaigns table in ReviewStore
(rounds FK runs and consolidations) — Campaign is a running/finished/failed
status union (stoppedBy only on finished, error only on failed, CHECKs
restate it in SQL), rounds store RoundOutcome as-it-happened with the whole
coverage snapshot (a later refutation or estimator tweak must not rewrite
what the loop saw when it decided to stop), and expectTypeOf pins
RoundOutcome === CampaignRound. Chunk 2: `runCampaign` writes its own
record — opened before the baseline judge call (visible from the first
tick), rounds appended as they land, finished with the stop reason *before*
verification (which bills to clusters and must not un-finish the loop);
every record write is observational (`onWarning`, never a dead paid loop),
while a structural throw fails the record and still propagates. Ownership
decides recovery: campaign jobs learn their campaign id
(`jobs.recordCampaign`, nullable-column migration) so serve startup fails
the campaign an interrupted worker job left mid-loop; the CLI covers its
own exits (throw → catch, Ctrl-C → SIGINT handler). Chunk 3: GET /campaigns
(target filter) + GET /campaigns/:id. Chunk 4: the loop band keys on the
stored record — rounds as the loop saw them, unusable rounds render × (not
a measured-looking 0), the stamp is campaign status/stoppedBy (dry,
max-runs, empty-diff read as completions; the two-strike stops as
failures) — with rev-derived novelty kept as the explicit fallback for
pre-persistence targets, now a value import of `novelClusters` from the
pure coverage module. Headless verification note: plain `firefox
--headless --screenshot` returns on the load event, before the first poll
tick paints — use geckodriver (npx works) + WebDriver, and `--no-remote`
is what unblocks a second Firefox instance beside a running desktop one.

**Slice 13 (campaign liveness leases — SQLite as the flock).** Closes slice
12's deliberate hole: a campaign killed without a signal (SIGKILL, power
loss) left its row `running` forever, and no other process could safely
fail it. The mechanism (`src/store/lease.ts`): the campaign loop holds
`BEGIN EXCLUSIVE` on a throwaway lock database
(`data/leases/campaign-<id>.lock`) for its whole life — SQLite implements
that with POSIX fcntl locks, which the kernel releases on ANY process
death, so "row running + lease acquirable" is *proof* of abandonment, not
a heuristic (no PID probing, no heartbeat timeouts). Key facts: SQLite
tracks locks per inode within a process (fcntl locks are per-process, the
classic footgun), so the serve process can sweep while its own worker holds
a campaign — asserted by a same-process test, and the SIGKILL guarantee by
a child-process test (kill -9, then reclaim). The lease is a hint, never
the authority: every sweep lands in `failCampaign`, whose running-state
guard settles all races (unlink-on-release included). Lifecycle lives in
the recorder — acquired with the record, released by finish/fail, and by
design a limbo row whose closing write failed becomes sweepable. Sweeps run
at writer startups (serve, CLI campaign) and on serve's poll interval —
never from read paths; reads don't write, even repairs. This *replaced*
slice 12's CLI SIGINT handler and job-linkage recovery (the linkage column
stays as provenance). One mechanism, all death modes. A campaign that
cannot acquire its lease still runs and bills (observational, warned) and
is sweepable-on-sight — degraded liveness is the stated cost. Leases live
beside the DB so an age-moved copy arrives with no live leases, which is
the truth. Test gotcha: vitest's NODE_OPTIONS loaders break a bare
`node -e` child — strip the env var when spawning. The parked road-not-
taken (an N-API flock addon) lives outside this repo, deliberately.

**Campaign #1 on the slice-12/13 branch itself** (2026-08-20, first
campaign to run under its own persistence: 6 runs, $19.38, stopped at
max-runs, 16 distinct findings, 7/7 once-seen CONFIRMED, textbook
saturation curve — est. ~4 of ~20 unseen). Its fix round: **campaigns
gained a `verifying` status** (running → verifying → finished; stoppedBy
becomes durable at the verifying transition, so a verify crash fails the
record without losing why the loop stopped — FailedCampaign carries an
optional stoppedBy for exactly that case; table-rebuild migration since
CHECKs live in the DDL). The lease is held through verification and the
sweep covers both live phases — the record had read 'finished' while the
CLI process billed five more dollars of adversarial passes, with every
billing gate reopened (user-felt live, then reported by the campaign in
4/6 runs). The create→lease race (6/6 runs) closed with a 10s grace window
in the sweep; the recorder now latches when the row leaves its hands (one
actionable warning, not one per round). Migration gotchas worth keeping:
**node:sqlite enables foreign-key enforcement by default** (unlike raw
SQLite), so dropping a referenced parent needs `PRAGMA foreign_keys=OFF`
bracketing the rebuild transaction (the pragma is a no-op inside one), and
`ALTER TABLE ... RENAME` rewrites dependents' REFERENCES since SQLite 3.25
— rebuild new-table-first, never rename-aside, when children point at the
table. Dashboard: 'verifying' counts as in-flight everywhere (header,
markers, lane, pulses, VERIFYING band stamp), the campaign fetch is
isolated/token-guarded/cached-when-terminal, unusable rounds render
dotted-× (distinct from barren — the patience rule's distinction, drawn),
the band is labeled "latest campaign" with per-scope cost labels, and the
watches panel got the bounded-scroll treatment inside the pinned column.

**Campaigns #2–3 (the PR-head target) and their fix round.** The user
promoted the trigger's held review to a campaign and later resumed it: 6
runs total ($14.73 reviews), 20 distinct findings, 10/11 once-seen
CONFIRMED, 1 refuted — and the estimate *rose* (27 → 32, ~12 unseen),
because the fix-round code was its own under-sampled population. Notable:
the 'verifying' phase was watched working live within an hour of shipping,
and the stale-tab OFFLINE note above was born when the browser's old
bundle rightly refused the new status value. The second fix round, from
its findings: the campaigns rebuild migration rolls back on failure and
copies by named columns (never positional `SELECT *` — TEXT-into-TEXT
shuffles are silent); the recorder's latch asks the store for the row's
state instead of parsing error wording (covers row-deleted, survives
rewording) and the warning channel is throw-proof; degraded-liveness rows
are recorded as such (`leased` column, defaulted ADD COLUMN) and the sweep
refuses to judge them — a false "owner gone" on a billing loop also
reopened the duplicate-campaign gates; sweep probes distinguish
SQLITE_BUSY (proof of life) from a broken lock file (reported with the
path to remove, never read as "alive", which wedged the target's gates);
sweeps are guarded at both call sites (a validator throw in setInterval
could kill serve); campaign transitions throw on zero-change races
instead of no-opping; the sheet gates on ANY live campaign in the filtered
list (newest-first order made the newest the wrong one to ask) and its
campaign reads are isolated with a three-strike "campaign data stale"
band marker; a held campaign job no longer hides a live CLI record from
the in-flight lane (only a running job owns a loop) and a live job now
outranks a terminal record in the band stamp; `/campaigns?live=1` bounds
the dashboard's 3s poll; the activity log height is fixed, not capped,
so the no-shift claim holds from line one; and the vacuous mid-loop lease
test now disables the grace window so it tests the lease.

**Campaigns #4–5 (fix-round-two head) and the third fix round.** 6 runs
($15.84), 15 findings, 8/8 once-seen CONFIRMED; the estimate stayed high
(~16 of ~31) because each fix round is its own fresh population — the
churn signal, not a bottomless branch. The round: **the duplicate-campaign
gate moved to the spending door** — runCampaign itself refuses when a live
record exists for the target (CLI exits 1, worker fails the job; the UI
gate is now advisory), closing the two-terminals double-bill. **Liveness
provability inverted to fail-safe**: rows are born `leased = 0` and marked
only after acquisition succeeds, so a crash in the create→acquire gap is
unsweepable instead of sweepable-while-alive; `leased` is surfaced on the
entity/summary so the UI can say "reads running but liveness is
unprovable". **The operator escape hatch exists**: `npm run campaign --
--force-fail <id>` retires a wedged live row (the store guard still
refuses terminal rows) — without it, an unprovable row wedged every
billing gate on its target forever, and now also the door gate. Probe
errors classify by SQLite errcode (5/6 = busy = alive; verified
empirically that node:sqlite sets errcode), never by message shape — a
regex miss would have advised deleting a LIVE campaign's lock file. The
sweep's cause names its own uncertainty ("owner died, or finished without
closing its record"), reports failCampaign refusals, and tidies orphaned
lock files of terminal rows. Mission control's campaign read got the same
isolation the sheet's had (one bad row 500-ing /campaigns blanked the
whole poll); baseline/round writes joined the changes-guard discipline
(the round INSERT carries its own EXISTS-status guard); onCampaign moved
inside the try that guarantees fail-and-release. Accepted with rationale
rather than changed: the sheet's target-scoped campaign list (bounded by
one target's history) and campaign_rounds keeping its original DDL (never
changed since birth; its own migration when it does).

**Run 60 (single-review tripwire) and the merge stopping rule.** After
three fix rounds the meta-loop needed a terminator: a single released
review ($3.16) with the decision pre-made — nit-only → merge; warning+ →
one targeted fix, then merge with the rest as follow-ups. It found 2
warnings + 3 nits. Fixed: `classifyProbeError` masks EXTENDED result
codes to the primary byte (node:sqlite reports sqlite3_extended_errcode —
SQLITE_BUSY_SNAPSHOT is 517, and unmasked it took the "broken" path and
its delete-a-live-lock advice); and the duplicate gate became atomic by
moving INTO `createCampaign` under BEGIN IMMEDIATE with a typed
`DuplicateCampaignError` that escapes the recorder's observational guard
— policy throws, persistence warns — closing the check-then-act window
the pre-check version had (and enforcing one live campaign per target at
the store level, which the tests now respect). Remaining nits logged
above.

Remaining roadmap (sequencing user-confirmed): deploy (webhooks may replace
polling then; needs server auth first). Eventually: read→write promotion
(posting findings to PRs) — a deliberate, separately-decided step with its
own risk profile, not a drift.

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
- **Cross-model corroboration can be wrong too** (2026-10-28, campaign #25 /
  consolidation #91): a [warning] seen in 3/4 rounds by both Opus 5.5 and
  Sonnet 5.5 ("concurrent duplicate insert → 500, comment over-claims") skipped
  verification as corroborated, and was false: the unique-violation → 422
  mapping lived in an action class the diff didn't touch, and no reviewer
  opened it. The PR author refuted it with two race tests. The other
  cross-model nit was skipped too (true; the PR listed it); the remaining
  four (three singletons, one same-model repeat) were verified and all
  confirmed. Agreement across
  models proves the diff reads that way, not that the code behaves that way;
  findings that need code outside the diff need the verifier. Evidence for
  making `--verify-all` the default before findings reach a human.
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

**Rotation resumes from the target's history (2026-10-29).** The lens and
model cycle was a function of the round number, so every campaign restarted
it: a follow-up campaign re-spent round 1 on a generalist pass the stored
runs already held, and with a four-round cap against five slots (generalist +
four lenses) the `tests` lens never ran — two live campaigns on one target,
eight rounds, zero `tests` rounds. Now `nextRound` (`src/campaign/rotation.ts`)
picks the lens slot this campaign has used least, breaking ties by the
target's stored runs (`ReviewStore.rotationSamples`), then by slot order — so
a fresh target plays out exactly as before, a campaign visits every slot once
before repeating any, and a starved slot leads each campaign until it has
caught up. Unlensed runs count as generalist. With a roster, the model is the
one least paired with that lens, then least used overall — so cross-model
agreement can accrue per lens instead of each lens settling on one model; a
campaign's own rounds may therefore all land on one model (the CLI banner
says "balanced per lens", no longer "rotating per round"). Caveat on the
evidence: the repeated generalist round in the second campaign still yielded
2 novel clusters, so "wasted round" was overstated — the real cost was the
starved lens.

The PR's own review (run #132, single opus run) shaped two rules. (1) Catch-up
by raw count — the first cut — handed a starved slot several rounds in a row:
under one model those are identical prompts riding each other's cache,
correlated samples that inflate occurrence and, finding nothing new after the
first, trip patience into a false `dry`. Hence once-per-slot per campaign.
(2) The tally counts aborted runs, not just submitted ones: they billed, and
left out, a lens that reliably aborts reads as unsampled forever and opens
every later campaign only to die at the abort tolerance. Empty runs are
excluded (they reviewed nothing). Known and accepted: single reviews and
label-triggered PR jobs are unlensed, so they count as generalist samples and
can push the generalist slot to the back of later campaigns on that target.
That retires the old "round 1 stays comparable with stored runs" property;
revisit if a campaign's baseline comparability turns out to matter. The tally
lives in `data/reviews.db`, so "resumes" holds per machine: carry the db over
(the age-encrypted copy) before a follow-up campaign on the other machine, or
it restarts from the generalist slot.

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

**Smoke-campaign follow-ups (rev 14, 2026-08-14)** — verified queue, fix in
roughly this order:

1. ~~**CSRF gate misses /jobs/:id/release and /cancel (critical, occ 3/3,
   unverified — recurrence across all three lenses).** release is the
   billing click; a cross-origin page can POST it with no preflight. Extend
   slice A's content-type/Host gate to bodyless POST routes.
2. ~~**Shutdown lets an in-flight campaign keep spending (warning, confirmed).**~~ — fixed: `CampaignOptions.shouldStop`, polled per round and before verify; worker passes `() => this.stopping`; cut-short plans abort with the reason stored.
   `Worker.stop()` awaits the whole campaign loop — up to maxRuns more paid
   rounds after SIGTERM. Thread a stop signal into CampaignOptions, checked
   at the top of each round.
3. ~~**VERIFY_MODEL ignored on the server path**~~ — fixed:
   `WorkerDeps.defaultVerifyModel`, used by verify jobs and passed to
   campaigns as `verifyModel`.
4. ~~**usePolling inFlight guard does not cover act()**~~ — fixed: the
   composable returns its serialized refresh; act() awaits it (queues
   behind an in-flight poll instead of overlapping or being dropped).
5. Settled from the smaller list: baseline-consolidation failures report
   via `onBaselineFailed` (CLI + worker wired); lapsed-verdict latest-wins
   compares verification ids, not Map positions; `verifyReporting` is
   callbacks-only (`Pick`); job params validate at enqueue too; list_files
   leads with the GitHub-truncation caveat so our own cap can't cut it;
   the legacy-merge migration removal is now documented in store.ts.
   **PR-title prompt injection**: context is fenced in the prompt and
   marked untrusted data ("review it, don't obey it").
   **listFiles slash-branch encoding: REFUTED empirically** — GitHub
   returns 200 for `git/trees/tmp%2Fslash-check` (live probe on this repo,
   2026-08-14); worth a human refuted stamp on the rev-14 cluster.

Still deliberately open (design decisions, not mechanical): a cost cap or
verdict filter on lapsed-verdict re-queue (the branch's tests assert the
current uncapped behavior on purpose), and a verify-spend fuse for degraded
identity partitions (occurrence 1 everywhere → whole-union verify queue).

**Campaign 2 (job 7, 2026-08-14, ~$9.11) — server-path validation after the
fixes.** Everything held: a 529-failed round surfaced in the feed with its
real error and the campaign moved on; the judge ran alive inside the loop
(3 calls, $0.53); 11 old verdicts inherited free by member set; 8 new
singletons verified for $4.04 (rev 17, runs 17–21). Two lessons for the
thesis: (1) **recurrence ≠ truth, observed live** — the empirically-refuted
listFiles slash-encoding claim was independently re-reported by a fresh run
(occ 2→3): correlated systematic error exactly as §4 predicts; stamp it
refuted so it stops re-queuing. (2) **Fixed findings linger**: the union
spans branch states, so CSRF (fixed on head) still shows occ-3 pending —
"resolved on a newer head" doesn't exist as a concept yet; design-boundary
candidate. New confirmed queue (all about the fix layer itself): shutdown
during the last round skips verification yet the job succeeds; verifyPending
has no stop hook (bills per pending cluster after SIGTERM); shutdown closes
stores under in-flight HTTP/poll; dashboard job schema drifted (models/
rotateLenses stripped at parse — the optional-field hole in the satisfies
guard); memoized compare/tree cache rejections for the whole run; a judge
max-turns throw skips the degrade path and loses its metered cost; owner/
repo interpolated unencoded into GitHub URLs from untrusted job input; a
never-settling refresh stalls the dashboard poller. Also: the campaign's
verification phase is invisible in the job feed (worker wires no
verifyReporting) — $4 spent silently.

**Queue policy change (same day, `4991be8`), prompted by the specimen:**
recurrence earns the verification skip only when it is **cross-model** —
`verificationQueue` takes a `modelOf` lookup (verifyPending builds it from
the consolidation's run rows) and same-model repeats verify like singletons;
no lookup → the old occurrence rule. **`--verify-all`** (CLI verify +
campaign, job params, worker) queues every pending cluster regardless of
corroboration — the user's stated ethic: "if I'm reviewing someone else's
code, I owe it to them to verify what I say." Opt-in for now; should become
the default of the read→write path (posting findings to PRs) if that lands.
The dashboard job-schema drift from the rev-17 queue was fixed in the same
commit (params now mirror every field; the satisfies guard's optional-field
blind spot is documented at the schema). ~~Rev-17 queue still open~~ — all
seven settled 2026-08-15: `shouldStop` now threads verifyPending →
verifyTarget → worker, so a SIGTERM stops the verification queue at the
next cluster boundary and a cut-short pass surfaces as `stopped`/aborted
instead of a completed plan (including the shutdown-lands-during-the-last-
round hole, which now flips `stoppedBy` to 'stopped' at the verification
gate); serve's shutdown closes the stores only after the worker drain, the
in-flight poll pass, and the server-closed callback — where the live test
of this very fix caught a hole: a socket that never sent a request (a
browser preconnect; reproduced with an idle `nc`) is closed by neither
close() nor closeIdleConnections(), and held shutdown hostage until the
socket died, so after the worker and poller settle lingering sockets get
a 2s grace and are then destroyed via closeAllConnections() (handlers are
synchronous — nothing store-touching can be in flight by then); the memoized compare/tree
promises drop themselves on rejection so one transient GitHub error no
longer poisons the whole run; a judge attempt that caps out on turns
returns its subtype-with-cost instead of throwing, so both attempts'
spend is metered and the identity-partition degrade path runs (retry
keeps the base prompt — a turn cap is not a partition violation to feed
back); GitHubClient encodes owner/repo (and compare's base/head) at every
URL site; usePolling gives an unsettled refresh a 30s stall deadline
before the guard is released (one bounded abandoned fetch beats a poller
stalled for the tab's life); and the worker wires verifyReporting so the
campaign's closing verification streams per-cluster events into the job
feed. User actions pending: stamp the slash-encoding cluster refuted in
the dashboard (rev 17; the probe is the rationale — it WILL recur
otherwise), widen the .env fine-grained PAT to cover this repo, restart
`npm run serve` (the process from today predates the day's last five
commits; stopped cleanly at day's end).

**Campaign 3 (2026-08-15, ~$11.46, CLI — the last CLI launch: launching via
the job API is the standing default now, so progress lands in the
dashboard).** Target: the rev-17 settlement layer itself (finishing-pass
against c05ea59, exactly the day's commits). Three rounds
(generalist/opus, security/sonnet, concurrency/opus), rev 19, 15 clusters,
--verify-all: 12 confirmed / 1 refuted / 2 undetermined, 0 incomplete.
Headline: **the reviewer caught a real bug in a same-day fix** — kickPoll
reassigned pollInFlight over an overlapping tick's early-return promise,
defeating the shutdown tracking that fix existed to add. The refutation
(#272) earned its keep too: a statement-by-statement synchronous-chain
trace proving the suggested guard would be dead code. Two "confirmed"
clusters were praise (the URL-encoding fix judged correct and well
tested — verify-all's cost includes verifying compliments). Undetermined
pair for a human: #274 (SDK iterator.return() semantics — settled in code
by consuming the stream fully instead) and #275 (does GitHub's compare
accept %2F refs — needs a live probe, still open). The rev-19 confirmed
queue was settled same-day: kickPoll guards before calling, the shutdown
chain has a .catch (exit 1, close error named), aborted campaign/verify
jobs keep their consolidationId, the judge degrade is scoped to
error_max_turns (other subtypes throw; schema-missing output retries with
cost kept; the stream is consumed fully with the standard rescue), the
campaign delegates the stop gate to verifyPending (empty queue + shutdown
= completed plan, not 'stopped'), VerifyPendingSummary carries queued vs
attempted, the usePolling stall deadline arms at actual start and clears
on unmount, and MissionControlView's refresh is generation-stamped so an
abandoned pass cannot clobber fresher state.

**Campaign 4 (job #8, 2026-08-15, $6.43) — first job-API launch; the whole
run lived in the dashboard feed, verification phase included (the rev-17
fix, observed working).** Target: the rev-19 settlement layer
(finishing-pass against 8936420). Rev 21: 7 clusters, --verify-all, 7/7
confirmed. The convergence curve is now data: 15 clusters/$11.46 → 7
clusters/$6.43, criticals moving from spend-and-shutdown to a poller edge
case. Headline again a bug in the fix of the fix: the stall deadline moved
to actual-start (rev 19 #280) left a *queued* refresh deadline-less while
its hung predecessor held its start() hostage — forever-stall one layer
deeper (#291, occ-2 cross-model, critical). Settled same-day (rev-21
queue): the guard-holder is never deadline-less (arm at enqueue, re-arm at
start, nothing re-arms after unmount); ClusteringError carries the metered
cost through structural judge throws and the campaign absorbs it into
judgeCostUsd; serve's closes stand alone (one throwing store no longer
skips the rest); the schema-miss retry feeds the mismatch back to the
judge; TargetSheet.refresh got its own generation stamp (the parent's
cannot see into the component); and verifyPending's pre-guard store reads
are documented as deliberate (queued-size must be known even under
shutdown; stores close only after the worker settles).

**Campaign 5 (job #9, 2026-08-15, $7.01) — the curve bends, and the loop's
own economics called the stop.** Target: the rev-21 settlement layer
(finishing-pass against 912f604). Rev 23: 10 clusters, --verify-all, 10/10
confirmed — count UP from 7 (verify-all props it with ever-smaller
findings) while depth kept falling: 0 criticals, 3 warnings (all one
family: cost-metering leaks introduced with ClusteringError — judge cost
lost when the save throws after a successful clustering; the carried cost
absorbed only by the campaign; a refresh queued behind a permanently hung
predecessor never settling), 7 nits including "these fixes ship with no
tests" and a naming complaint. Marginal round bought zero criticals →
stopped the loop, settled rev 23 in code without a campaign 6:
consolidateRuns wraps post-judge throws in ClusteringError (meter rides
out), the error's message itself names the spend (every path that only
prints or stores the error now carries it), schema-miss retry feedback is
framed as a schema problem and capped at 3 issues, a queued refresh races
its predecessor against the enqueue deadline (always starts, always
settles; the deadline means "the wait is over", not "release the guard" —
found by the new test), stamp() bumps the generation so in-flight
refreshes can't overwrite a fresh verdict, and the dashboard got its own
vitest suite (happy-dom + @vue/test-utils; root config now excludes it) —
4 fake-timer tests over usePolling's guard/deadline semantics. Three-
campaign total: ~$24.90. README gained "The loop, measured" with the bent
curve told honestly.

~~Queued for the README: a "When to use this" section~~ — landed
2026-08-15, with one deliberate departure from the queued spec: the
six-cycle origin anecdote stays OUT of the README (decided on seeing it in
place — the personal story doesn't belong in the published artifact; the
economics stand without it). What shipped: the sampler-in-denial framing
stated impersonally, cost-per-merged-PR vs cost-per-pass, the three
postures (trivial → skip; normal → one pass, findings as labeled claims;
high-risk → campaign + cross-model rotation + --verify-all), calibrated
positive confidence never absence-of-bugs, and the capture-recapture
lineage citation (Eick 1992, Wohlin & Runeson 1998, Briand 2000) in
thesis §3.

**Slice-11 follow-ups** — from the self-review of chunks 2–4 (run 22 → rev
15, verified 8/8 for $4.98: 7 confirmed, 1 refuted). The loop ran with no
CLI: review job → auto-proposed held verify job → release → verdicts.
Resolved in the finishing pass (slice A), except #134 which lands with the
verify-orchestration test seams:

1. ~~**Worker ordering bug (warning, #135)**~~ — fixed: `succeed()` first,
   the verify proposal in its own try/catch that only reports via onEvent.
2. ~~**Concurrent refresh duplicates feed events (warning, #133)**~~ —
   fixed: `usePolling` has an in-flight guard.
3. ~~**`verifyTarget` is untested (warning, #134)**~~ — fixed in slice C:
   `verifyTarget`/`verifyPending` gained injectable stage runners (the
   WorkerDeps seam, one layer down) and the reuse gate, vacuous success,
   re-consolidation, base pinning, and record-and-continue are all covered;
   `runCampaign`'s stopping rules and judge-failure salvage likewise.
4. ~~**"verify now" ignores held verify jobs (nit, #139)**~~ — fixed:
   `hasOpenVerify` (held/queued/running verify) gates `canVerify`.
5. ~~**Reuse lookup filters triple, runs filter quad (nit, #140)**~~ —
   fixed: `TargetFilter` takes an optional base, pinned by
   `submittedRunsFor` and `verifyTarget`'s reuse lookup.
6. ~~**Compare fetched twice per review (nit, #136)**~~ — fixed:
   `createReviewTools` exposes the memoized `changedFiles`, and an empty
   diff now aborts the run (`reason: 'empty-diff'`) before any credit moves.
7. ~~**Dead kick in serve's poll (nit, #137)**~~ — deleted with a comment.

**Finishing-pass fixes beyond the list (slice A):** the worker's drain chain
no longer wedges permanently after a rethrow (settled tail); a judge failure
mid-campaign no longer discards the campaign's product (round-level catch +
identity-partition fallback after retry exhaustion, reported via
onDegraded/onJudgeDegraded); `POST /jobs` requires `application/json` and a
loopback Host (a cross-origin page could otherwise spend credit with a
no-preflight `start: true` POST — localhost binding does not stop a browser);
500 bodies are generic with the detail in the activity feed; store errors are
no longer laundered into 404/409 (named-error prefixes only); foreign keys
are enforced (`PRAGMA foreign_keys = ON`) with indexes on the four hot
lookups.
**Slice-11 follow-ups: all seven landed** (from the self-review of chunks
2–4, run 22 → rev 15, verified 8/8 for $4.98: 7 confirmed, 1 refuted; #138 —
refuted clusters counting as novel in the campaign stop rule — was itself
REFUTED by the adversary, no action). What each fix became:

1. Worker ordering (#135): `jobs.succeed()` now runs before the held verify
   proposal, and the proposal has its own catch that only reports via
   onEvent — a failed follow-up write can no longer fail a review that ran,
   billed, and saved.
2. Feed duplicates (#133): the tail is filtered against the cursor at append
   time (`e.seq > cursor.value`), and `usePolling` gained an in-flight guard
   (skip, not queue).
3. `verifyTarget` tests (#134): five scenarios in `test/verify`, judge
   mocked at `runClustering`, clusters arranged occurrence ≥ 2 so no test
   can reach a paid verifyCluster call.
4. "verify now" vs held jobs (#139): `canVerify` became a discriminated
   `VerifyGate`; a held verify job blocks the button and the tooltip points
   at its ▶ in the intake stage.
5. Base pin (#140): `TargetFilter` gained optional `base`, honored by
   `listRuns`/`listConsolidations`; verifyTarget's reuse lookup pins it.
6. Double compare (#136): `createReviewTools` exposes the memoized
   `changedFiles`; the pre-flight count rides it, and `filesChanged === 0`
   now short-circuits the review entirely — the empty-diff tell is a cost
   fuse (zero turns, zero credit, canned "Empty diff" submitted review).
7. Dead kick (#137): deleted; the release endpoint kicks the worker itself.

**PR #5 campaign follow-ups** — two campaigns reviewed the branch itself.
Campaign 1 (consolidation #22: 10 findings, 7/7 singletons CONFIRMED,
$12.27) produced the first fix round: empty-diff runs filtered from the
union, base plumbed over HTTP, a 10s fetch timeout so the poll guard cannot
latch, the campaign CTA gated like the verify button (`ActionGate`), an SDK
mock so the runReview test cannot bill on regression, a self-healing worker
drain chain, ZERO_USAGE deduped. Campaign 2 crashed the judge
(error_max_turns under maxTurns 1 — structured output is a tool call, so a
retry needs turns; now 4, and a judge failure costs a round, never the
campaign) and, rerun over 5 unioned runs (consolidation #26: 12 findings,
6/6 singletons CONFIRMED, $13.76), converged on the short-circuit's
fabricated `submitted` review. That became the second fix round: **runs now
have a third status, `'empty'`** (its own `ReviewResult` member, store
migration for the fabricated rows, every status reader — worker, campaign
`stoppedBy: 'empty-diff'`, both CLIs, dashboard — discriminates on it), plus
the base query-param edges (lone/empty base → 400), the timeout spread
order, frozen ZERO_USAGE, a rejection handler in usePolling's guard, and a
vacuous verify for all-empty targets. Campaign 3 over the 'empty' slice
(consolidation #27: 6 findings across 2 runs — one round lost to a 529,
absorbed as designed; both singletons CONFIRMED; est. ~7 total, near
saturation) hardened the new edges in a third round: the migration predicate
pinned to the short-circuit's full signature (turns = 0 AND cost = 0, so a
genuine billed review of an empty compare survives), verify's onlyEmpty is
every-not-some (an empty run cannot mask all-aborted attempts), a judge-
failure fuse mirrors ABORT_TOLERANCE (`stoppedBy: 'no-consolidation'`,
worker aborts the job), and — the one deliberate divergence from the
verbatim port — `compare()` throws when GitHub omits `files`, so a
truncated compare fails retryably instead of reading as an empty branch
that the trigger's any-state dedupe would never review. Plus symmetric
400s for present-but-empty filter params and a 400 message that covers the
base rules. Still open (deliberately deferred):

- A failed verify proposal survives only in the in-memory event ring — a
  durable note wants the same slice as "needs human eyes" / job-result
  fields.
- `act()` bypasses usePolling's in-flight guard — cosmetic last-writer-wins
  on jobs/watches/targets, self-corrects next tick.

- "Needs human eyes" has no answer path — a human-verdict row on top of agent
  verdicts (append-only makes overrule natural).
- ~~Server has no graceful shutdown~~ — fixed in the finishing pass:
  SIGINT/SIGTERM drains gracefully, second signal abandons.
- Server has no auth of its own — safe only because it binds 127.0.0.1;
  auth must land before any exposure (deploy slice, where webhooks may also
  replace polling).
- A standing watch exists on this repo (label `agent-review`): any labeled
  PR gets auto-reviewed whenever the server runs. Deliberate — remove via
  DELETE /watches if unwanted.
- **Run-60 follow-ups (nit-grade, logged per the merge stopping rule):**
  a campaign finishing between `openCampaigns()` and the sweep's probe
  produces an alarming "could not be marked failed" warning for a healthy
  outcome — detect the guard-refusal case and stay quiet or say "finished
  normally mid-sweep"; and `leaseDir` derives from the database's
  *directory*, so two ReviewStore databases in one directory would share a
  lock namespace and `cleanOrphanedLocks` could delete a neighbour's live
  lock — derive it from the filename (e.g. `reviews.db.leases/`) if a
  second store ever shares a directory. Fixed from the same review, beyond
  the two warnings: `--force-fail` honored only as the leading argument (a
  destructive flag must be the whole command, not a stray rider).
- **Stale-tab OFFLINE costume (user-felt, unscheduled).** A long-lived
  dashboard tab keeps polling with its old bundle; when the server starts
  sending a value the old wire schema doesn't know (seen live 2026-08-20:
  campaign status 'verifying' minutes after it shipped), the Zod guard
  rightly refuses — but the failure renders as OFFLINE, which reads as
  "server gone", not "your tab is stale". Fix shape: the client
  distinguishes parse failure (response arrived, schema refused) from
  fetch failure, and says "reload — the dashboard was updated". The guard
  itself is working as designed and stays.
- **Campaign abort button (user-requested, unscheduled).** A soft abort at
  round boundaries: the dashboard writes an `abort_requested` flag on the
  campaign row, both loops (CLI and worker share the store) check it at the
  top of each round, and stop with a new StoppedBy (`'human-abort'`). The
  flag-through-the-shared-file is the only way a dashboard click can stop a
  CLI loop, and the round boundary is where stopping is clean (run saved,
  nothing half-written). Would be the second deliberate human-write
  endpoint after verdicts — revoking spend is the inverse of ▶ release.
  To settle when built: skip verification on abort (default yes — the
  click said "stop spending"; verify stays one click away); hard kills
  stay the lease sweep's job, not this flag's. The CLI half-sibling
  already exists: `--force-fail <id>` retires a wedged record (but does
  not stop a live loop — that is exactly what the flag adds).
- Judge golden set is a single fixture — grow it as human-verified
  consolidations accumulate (`npm run eval:freeze`).
- **Ensemble expansion idea (user, 2026-08-14, explicitly not now):** beyond
  cycling one (lens, model) pair per round, run the grid — multiple prompt
  variants × multiple models per round, or randomized prompt paraphrases —
  so each round samples a designed ensemble cell. The per-run `lens` and
  `model` columns already record the coordinates; coverage could then
  stratify by cell. Cost scales linearly with cells, so this waits for
  evidence from the two-model roster experiment first.
- **Areas to explore (finding presentation, unscheduled):** the dashboard
  is where this bites — the user flagged how text is presented there as
  future work (2026-10-29). `BlueprintCallout.vue` interpolates finding
  detail and verdict rationale as plain text, so the verifier's numbered
  evidence lists and backticked code arrive as one blob; the items below are
  the candidate fixes.
  - Simplified Technical English (STE) — could the reviewer's prose
    (finding detail/rationale text) be constrained to it, or checked
    against it?
  - Render code distinctly from prose in finding text (Stack
    Exchange-style code formatting) instead of one undifferentiated blob.
  - Numbered points each on their own line, indented, rather than run
    together in a paragraph.
- **Local-git `RepoClient` (todo, user-requested 2026-10-09):** review a
  clone on disk instead of through the GitHub API — `compare()` via
  `git diff --merge-base`, `readFile` via `git show <ref>:<path>`. The tools
  already depend only on the `RepoClient` interface, so it slots in beside
  `GitHubClient`. Wins: unpushed branches become reviewable, and no
  300-file compare cap. Open question: how a job names a local target
  (path vs owner/repo) without breaking target identity in the store.
- **Runs don't record the reviewed head SHA (todo, user-requested
  2026-10-28):** `Target` is owner/repo/head-branch/base, so a re-review
  after fixes lands in the same target as the pre-fix runs.
  `submittedRunsFor` unions them, fixed findings keep inflating occurrence,
  and member-set verdict inheritance can carry a `confirmed` onto code that
  no longer has the defect. Surfaced when a re-review was requested on a PR
  that had already had a campaign. Fix direction: store the compared head
  SHA on each run (resolve the branch ref once at review start, so the
  tools and the record agree on the commit), and scope
  consolidation/inheritance to runs of the current SHA, or flag stale-SHA
  members. Until then: re-review with a single `review` and check fixes by
  hand, or campaign with `--reverify`.
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

**Reconciliation (2026-10-15).** Two lines of work had forked from `b60e9fb`
(2026-08-11) without seeing each other: the finishing pass on this machine
(slices A–D, rev-14 → rev-23 settlements, model policy, lenses, graceful
shutdown, MIT; 26 commits to 2026-08-16) and slices 11–12 on `origin/main`
(the `empty` run status, persisted campaigns with liveness leases and the
sweep, `--force-fail`, campaign liveness in the dashboard; 23 commits to
2026-08-20, PRs #5 and #6). 26 files conflicted. Resolution policy: union
of features; where the two lines disagreed on semantics, the newer
mechanism won and the other line's policy was re-applied on top of it —
the `empty` status replaces the finishing pass's `empty-diff` abort (the
store migration, the campaign's `empty-diff` stop, and the worker's
empty-success path all come from slice 11); the campaign loop is slice
12's recorder/lease structure carrying the finishing pass's runners seam,
lens/model rotation, `shouldStop`, judge-cost metering, forfeitable
baseline, and `verifyAll`/`verifyModel`; the dashboard keeps the
finishing pass's grid layout (activity feed fills the left column) with
slice 12's live-campaign count and row markers added; `usePolling` keeps
the rev-21/23 guard-and-deadline semantics (slice 12's simpler inFlight
flag was the older design). Three things neither line had: `stopped`
joined the persisted `StoppedBy` vocabulary (campaign CHECKs, dashboard
schema, LoopBand), `finishVerifiedCampaign` can restate `stopped_by` when
verification itself was cut short, and `campaign_rounds` gained `lens` and
`model` columns (ADD COLUMN migration) so the compile-time
RoundOutcome ≡ CampaignRound contract holds with rotation recorded. Both
suites green (359 unit, 4 dashboard); typecheck and lint clean. The
pre-merge local line is preserved as `origin/finishing-pass`.
