# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Branch review agent built on the Claude Agent SDK, running on **subscription credit only** — `assertSubscriptionCredit()` in `src/review/review.ts` refuses to run if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set, so a run can never silently bill pay-as-you-go. Headless machines authenticate with `CLAUDE_CODE_OAUTH_TOKEN` (minted by `claude setup-token`, subscription credit by construction) in `.env`. Read-and-report only: reviews a GitHub branch against its merge base and reports structured findings; no editing, no fixing.

Fresh-start successor to [branch-reviewer-api](https://github.com/racoonamatatas/branch-reviewer-api), which hand-rolls the same agent loop against the raw Messages API. The two reviewers deliberately differ only in harness — `src/github/github.ts` is ported verbatim, the tools keep the same names and behavior.

This is a learning project, not a delivery: build in small slices, propose a short plan and get a go-ahead before anything beyond a small slice, and pause after each logical chunk for a walkthrough.

## Commands

```
npm test                    # vitest run (unit suite, fast, no network/model calls)
npx vitest run test/store   # single test dir; any vitest filter works
npm run typecheck           # tsc --noEmit
npm run lint                # eslint .
```

CLI entry points (all tsx, `--env-file-if-exists=.env` for `GITHUB_TOKEN` / `REVIEW_MODEL`):

```
npm run review -- <owner>/<repo> <branch> [--base main] [--max-turns N] [--verbose] [--no-save]
npm run history [-- <run-id>]
npm run consolidate -- <run-id> <run-id> [...] | --show <consolidation-id>
npm run verify -- <consolidation-id> [--max-turns N] [--reverify]
npm run campaign -- <owner>/<repo> <branch> [--base main] [--max-runs N] [--patience K] [--max-turns N] [--no-verify] [--reverify]
npm run eval:freeze -- <consolidation-id>   # freeze a consolidation as the judge's golden fixture
npm run eval:judge                          # stochastic judge eval — run on demand, NOT part of the unit suite
```

Model defaults to `claude-opus-5`; override with `REVIEW_MODEL`. Everything that calls the model burns real subscription credit — never run review/consolidate/verify/campaign/eval:judge as a casual check.

## Architecture

Pipeline stages, each a directory under `src/` (tests mirror the tree under `test/`):

1. **review** — one `query()` call per branch review. The SDK owns the loop/dispatch/validation; this module is wiring, policy, and the system prompt. Three in-process MCP read tools (`src/tools/tools.ts`: list_changed_files, get_diff, read_file) over a `RepoClient` (`src/github/github.ts`, three-dot compare = merge-base semantics). Output arrives via `outputFormat: json_schema`; no submit tool.
2. **store** — run history on built-in `node:sqlite` (Node ≥ 24, no native dep) at `data/reviews.db` (gitignored, local-only — finding text contains repo internals). Findings are relational rows, not a JSON blob, because cross-run comparison queries them.
3. **consolidate** — semantic clustering of findings across runs of the same target, judged by a tool-less one-turn `query()`. The judge proposes a partition of finding ids; validation (ids exist, partition is exact) is ours.
4. **verify** — adversarial agent per occurrence-1 finding: same three tools, prompt inverted to refute. Three-valued verdict — confirmed / refuted / undetermined — because "couldn't refute" must never launder into "refuted". Verdicts inherit across consolidations by identical member set; `--reverify` re-tests deliberately.
5. **coverage** — capture-recapture estimator (`coverageOf`) over cluster occurrence counts: singletons/doubletons estimate how many findings remain unseen. Structurally typed on `{ occurrence }`, free of store and campaign.
6. **campaign** — the loop tying it together: review the same target repeatedly (rounds share prompt cache in one process), re-consolidate after each round, stop when rounds stop yielding novel clusters (patience) or on two consecutive aborts, then verify pending singletons.

Key facts that shape the code:

- **Single runs are samples, not surveys.** Six reviews of one branch proved it; the trustworthy artifact is the union across runs. Campaign exists to answer "how many more runs?".
- **Usage accounting is observational, never gating** (`src/usage/usage.ts`). Parallel tool calls share one message id — the accumulator dedupes by id. The SDK result's totals are authoritative; our streamed sum may differ and callers only report the delta.
- **`num_turns` ≠ the maxTurns budget.** Compaction appears to reset the budget; `compact_boundary` messages are counted for that reason. Default review budget is 40 (20 aborted real campaign rounds).
- **Persistence and saves never change a review's outcome or exit code** — a failed save warns and moves on.
- Exit codes: 0 clean, 1 critical finding (or crash), 2 aborted.

## Type conventions

Defined in `src/types/common.ts` and `src/types/ids.ts`; follow them for any new entity:

- Entities are bare nouns (`Run`, `Finding`) mixing in `Identified<T>`/`Created`; create-shapes derive **down** by subtraction (`New<T> = Omit<...>`), never up by extension. `id`/`createdAt` are store-assigned; callers never pass them.
- Ids are branded numbers; the only way in is a checking constructor (`runId(n)`), the only `as Id` cast in the project lives in `idConstructor`. Model-authored ids (the least-trusted numbers in the system) gain their brand during Zod parse via `toTypedId`.
- Zod is the runtime source of truth for wire shapes; TS types are inferred and JSON Schema for the SDK's `outputFormat` is generated (`z.toJSONSchema`, `io: 'input'` when the schema contains transforms).

## Style

- Allman braces, 4-space indent, single quotes, semicolons — enforced by ESLint `@stylistic` (Prettier can't do Allman; don't add it).
- Strict TS with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; ESM (`"type": "module"`) with `.js` extensions on relative imports.
- Comments explain constraints and evidence ("20 aborted two of three campaign rounds"), not what the next line does. Match that density.
- Test names are `it('should ...')`.

## Eval

`eval/` is the judge's regression harness, separate from the unit suite because the judge is stochastic: `eval:freeze` snapshots a human-verified consolidation into `eval/fixtures/` (gitignored, contains repo internals), `eval:judge` replays it through `runClustering` and scores the partition. A fail is a signal to inspect, not a hard fact.
