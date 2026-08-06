# NOTES.md — project state across machines

Canonical store of project state, roadmap, and settled decisions, so a session
on any machine starts with full context. **Update this file whenever a slice
ships or a design decision lands** — it replaces machine-local session memory
as the source of truth. Keep raw finding text and target-repo code internals
out of it (same rule as `data/` and `eval/fixtures/`, which stay local); the
finding *labels* used below are fine.

## Status (2026-08-06)

Slices 1–6 shipped. **Next: slice 7 — headless auth** (`claude setup-token` →
`CLAUDE_CODE_OAUTH_TOKEN`), deliberately sequenced before the server, which
presumes it.

Remaining roadmap (sequencing user-confirmed): Node server + job model →
trigger automation (webhook/CI, its own slice — auth = *can* run anywhere,
triggers = something else decides *when*) → Vue TS dashboard (last, standing
decision) → deploy. Eventually: read→write promotion (posting findings to PRs)
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
  `ANTHROPIC_API_KEY` is set (API-key-vs-login precedence is undocumented).
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
  under a cap of 20 without aborting — auto-compaction resetting the budget is
  the leading hypothesis; `compact_boundary` messages are now counted and
  printed, so the next over-cap run answers it.
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

## Open items

- Slice 7 (headless auth): verify `CLAUDE_CODE_OAUTH_TOKEN` works logged-out;
  decide whether `assertSubscriptionCredit()` needs to reason about it.
- "Needs human eyes" has no answer path — a human-verdict row on top of agent
  verdicts (append-only makes overrule natural).
- README documents only the reviewer; history/consolidate/verify/campaign/eval
  commands are missing.
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
