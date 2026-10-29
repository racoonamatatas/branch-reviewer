# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Branch review agent built on the Claude Agent SDK, running on **subscription credit only** — `assertSubscriptionCredit()` in `src/review/review.ts` refuses to run if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set, so a run can never silently bill pay-as-you-go. Headless machines authenticate with `CLAUDE_CODE_OAUTH_TOKEN` (minted by `claude setup-token`, subscription credit by construction) in `.env`. Read-and-report only: reviews a GitHub branch against its merge base and reports structured findings; no editing, no fixing.

Fresh-start successor to [branch-reviewer-api](https://github.com/racoonamatatas/branch-reviewer-api), which hand-rolls the same agent loop against the raw Messages API. `src/github/github.ts` began as a verbatim port so the two reviewers differed only in harness; `listFiles` (backing the `list_files` tool) is the first deliberate departure — the predecessor's verifier could only read exact paths and had to guess where config/CI/deploy files live. The second: `compare()` throws when GitHub omits the `files` key (oversized comparison) instead of reading it as an empty diff, because an empty diff is a terminal success downstream.

This is a learning project, not a delivery: build in small slices, propose a short plan and get a go-ahead before anything beyond a small slice, and pause after each logical chunk for a walkthrough.

## Commands

```
npm test                    # vitest run (unit suite, fast, no network/model calls; excludes dashboard/)
npx vitest run test/store   # single test dir; any vitest filter works
npm test --prefix dashboard # dashboard suite (happy-dom; usePolling guard/deadline semantics)
npm run typecheck           # tsc --noEmit
npm run lint                # eslint .
```

CLI entry points (all tsx, `--env-file-if-exists=.env` for `GITHUB_TOKEN` / `REVIEW_MODEL`):

```
npm run review -- <owner>/<repo> <branch> [--base main] [--max-turns N] [--verbose] [--no-save]
npm run history [-- <run-id>]
npm run consolidate -- <run-id> [...] | --show <consolidation-id>   # a single run is valid: clustering is what makes findings verifiable
npm run verify -- <consolidation-id> [--max-turns N] [--reverify] [--verify-all]
npm run campaign -- <owner>/<repo> <branch> [--base main] [--max-runs N] [--patience K] [--max-turns N] [--no-verify] [--reverify] [--verify-all] [--models a,b] [--no-lenses]
npm run campaign -- --force-fail <campaign-id>   # retire a wedged live campaign record (liveness unprovable)
npm run serve [-- --port N] [--poll-interval seconds]   # job server on 127.0.0.1:4780; enqueued jobs bill like the CLI commands; polls watches for labeled PRs; serves dashboard/dist when built
npm run eval:freeze -- <consolidation-id>   # freeze a consolidation as the judge's golden fixture
npm run eval:judge [-- --trials N]          # stochastic judge eval (pass rate + pair precision/recall) — run on demand, NOT part of the unit suite; every trial bills a judge call
```

Model policy lives in `src/sdk/models.ts`, one knob per role: reviewer `REVIEW_MODEL` (default `claude-opus-5`), clustering judge `JUDGE_MODEL` (default `claude-sonnet-5` — a matching problem doesn't need Opus), verifier `VERIFY_MODEL` (defaults to the reviewer's model). Campaigns rotate the review model per round by default (`DEFAULT_REVIEW_MODELS`: `claude-opus-5` + `claude-sonnet-5-5`); `REVIEW_MODELS` (comma list) replaces the roster, a lone `REVIEW_MODEL` or a job's single `model` makes a campaign single-model. Every `query()` resolves its own default; nothing falls through to the SDK's. The SDK is pinned exactly: its version tracks the bundled Claude Code build, which gates which model ids run (the 5.5 ids need ≥ 0.3.280 — 0.3.222 rejected `claude-opus-5-5` with a 400). Everything that calls the model burns real subscription credit — never run review/consolidate/verify/campaign/eval:judge as a casual check.

## Architecture

Pipeline stages, each a directory under `src/` (tests mirror the tree under `test/`):

1. **review** — one `query()` call per branch review. The SDK owns the loop/dispatch/validation; this module is wiring, policy, and the system prompt (recall-first: report low-confidence findings too, downstream filters). Four in-process MCP read tools (`src/tools/tools.ts`: list_changed_files, get_diff, read_file, list_files) over a `RepoClient` (`src/github/github.ts`, three-dot compare = merge-base semantics). Findings carry a `confidence` enum; an empty diff is its own result status (`empty`, not a submitted review with zero findings) and short-circuits before any credit moves — the store migrates older fabricated rows to it, and `submittedRunsFor` never admits them to a union. Output arrives via `outputFormat: json_schema`; no submit tool.
2. **store** — run history on built-in `node:sqlite` (Node ≥ 24, no native dep) at `data/reviews.db` (gitignored, local-only — finding text contains repo internals). Findings are relational rows, not a JSON blob, because cross-run comparison queries them.
3. **consolidate** — semantic clustering of findings across runs of the same target, judged by a tool-less one-turn `query()`. The judge proposes a partition of finding ids; validation (ids exist, partition is exact) is ours. After retry exhaustion it degrades to the identity partition (reported via `onDegraded`) instead of throwing; judge cost is metered and stored on the consolidation.
4. **verify** — a settlement agent per queued finding: same four tools, symmetric confirm-or-refute prompt (the old refute-anchored framing would shred a recall-first reviewer's low-confidence findings). Three-valued verdict — confirmed / refuted / undetermined — because "couldn't refute" must never launder into "refuted". The queue admits every pending cluster without **cross-model** corroboration: same-model recurrence is self-agreement, not evidence (proven live — an empirically false claim recurred 3× from one model), and `--verify-all` queues even corroborated ones for findings a human will be handed. Verdicts inherit across consolidations by identical member set; a cluster whose member set strictly absorbs an adjudicated one records the `lapsedVerdict` and re-enters the queue with it as context; `--reverify` re-tests deliberately.
5. **coverage** — capture-recapture estimator (`coverageOf`, bias-corrected Chao1) over cluster occurrence counts. Chao1 assumes independent samples and campaign rounds are correlated, so the estimate is reported as an optimistic ceiling, never gates anything. Structurally typed on `{ occurrence }`, free of store and campaign.
6. **campaign** — the loop tying it together: review the same target repeatedly (rounds share prompt cache in one process), re-consolidate after each round, stop when rounds stop yielding novel clusters (patience) or on two consecutive aborts, then verify pending singletons. Rounds are diversity-sampled against Chao1's independence assumption: a reviewer lens rotates per round (`src/review/lenses.ts`, on by default; `src/campaign/rotation.ts` picks the least-sampled lens and model from the target's stored runs, so a follow-up campaign resumes rather than restarts) riding the user prompt so the system prompt stays the shared cache prefix, and the review model cycles by default (`--models`/`REVIEW_MODELS` replace the roster) so occurrence reads as cross-model agreement; lens and resolved model are recorded on the run and on the campaign round. Campaigns are persisted (`campaigns` + `campaign_rounds`, a snapshot of what the loop saw when it decided, with `stoppedBy` durable before verification bills): the record opens before the baseline judge call, every write through `CampaignRecorder` is observational (warns, never kills a billing loop), and a liveness lease (`src/store/lease.ts`, a kernel-released lock file) lets the writer-startup / poll-interval sweep prove an abandoned `running` row dead instead of guessing. The duplicate gate is `createCampaign` itself; a wedged unprovable row is retired with `npm run campaign -- --force-fail <id>`. An empty diff ends the campaign (`empty-diff`), two judge failures in a row end it (`no-consolidation`), a shutdown cuts it short (`stopped`).
7. **server** — durable job queue (`src/server/jobs.ts`, guarded state machine in the same SQLite file), a single sequential worker (`src/server/worker.ts`, injectable runners, outcomes mapped onto the error taxonomy), and an HTTP surface on `node:http` (`src/server/server.ts`; wiring in `src/cli/serve.ts`, localhost only). Interrupted jobs are marked failed at startup, never silently re-run. Shutdown is graceful: SIGINT/SIGTERM stops claiming and lets the in-flight job record its outcome (`Worker.stop()`); a second signal abandons it to startup recovery.
8. **trigger** — label-gated PR polling (`src/server/trigger.ts`): watches (owner/repo/label rows) + `pollOnce`, which enqueues a review job per labeled non-draft PR head SHA with no existing job in any state. `PullSource` in `src/github/github.ts` is the trigger's own interface, separate from the review-tool contract. Per-cycle enqueue cap as the cost fuse; labeled PRs enqueue held, with the PR title riding along as reviewer context.

Key facts that shape the code:

- **Single runs are samples, not surveys.** Six reviews of one branch proved it; the trustworthy artifact is the union across runs. Campaign exists to answer "how many more runs?".
- **Usage accounting is observational, never gating** (`src/usage/usage.ts`). Parallel tool calls share one message id — the accumulator dedupes by id. The SDK result's totals are authoritative; our streamed sum may differ and callers only report the delta.
- **`num_turns` ≠ the maxTurns budget.** Compaction appears to reset the budget; `compact_boundary` messages are counted for that reason. Default review budget is 40 (20 aborted real campaign rounds).
- **Persistence and saves never change a review's outcome or exit code** — a failed save warns and moves on.
- Exit codes: 0 clean, 1 critical finding (or crash), 2 aborted.

## Type conventions

Defined in `src/types/common.ts` and `src/types/ids.ts`; follow them for any new entity:

- Entities are bare nouns (`Run`, `Finding`) mixing in `Identified<T>`/`Created`; create-shapes derive **down** by subtraction (`New<T>`, a distributive `Omit` so union entities keep their halves apart), never up by extension. `id`/`createdAt` are store-assigned; callers never pass them.
- Ids are branded numbers; the only way in is a checking constructor (`runId(n)`), the only `as Id` cast in the project lives in `idConstructor`. Model-authored ids (the least-trusted numbers in the system) gain their brand during Zod parse via `toTypedId`.
- Zod is the runtime source of truth for wire shapes; TS types are inferred and JSON Schema for the SDK's `outputFormat` is generated (`z.toJSONSchema`, `io: 'input'` when the schema contains transforms).

## Style

- Allman braces, 4-space indent, single quotes, semicolons — enforced by ESLint `@stylistic` (Prettier can't do Allman; don't add it).
- Strict TS with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; ESM (`"type": "module"`) with `.js` extensions on relative imports.
- Comments explain constraints and evidence ("20 aborted two of three campaign rounds"), not what the next line does. Match that density.
- Test names are `it('should ...')`.

## Eval

`eval/` is the judge's regression harness, separate from the unit suite because the judge is stochastic: `eval:freeze` snapshots a human-verified consolidation into `eval/fixtures/` (gitignored, contains repo internals), `eval:judge` replays it through `runClustering` and scores the partition. A fail is a signal to inspect, not a hard fact.
