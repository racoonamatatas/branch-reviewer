// The review runner: everything the predecessor's loop.ts did, expressed as
// one query() call. The SDK owns the loop, dispatch, validation, retries, and
// termination; what remains here is wiring, policy, and progress reporting.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelUsage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RepoClient } from '../github/github.js';
import { reviewModel } from '../sdk/models.js';
import { reviewJsonSchema, reviewSchema } from '../schema/schema.js';
import type { Review } from '../schema/schema.js';
import { createReviewTools, SERVER_NAME } from '../tools/tools.js';
import type { ReviewTarget } from '../tools/tools.js';
import { UsageAccumulator, fromWireUsage } from '../usage/usage.js';
import type { TokenUsage, TurnUsage } from '../usage/usage.js';

// A review of the reference target streams ~30 tool calls, and `num_turns`
// comes back as tool calls + 2 (the initial prompt and the final answer),
// measured across every run and verification in the store. 20 aborted two of
// three campaign rounds; 40 leaves headroom for a diff twice that size.
// Caveat: the budget and `num_turns` are not the same counter — parallel tool
// blocks arrive in one round-trip, and an aborted run reports exactly
// maxTurns + 1 while a successful one has been seen to report 32 under a cap
// of 20. Compaction resetting the budget is the leading explanation, which is
// why compact_boundary is now counted below.
const DEFAULT_MAX_TURNS = 40;

// Recall-first, deliberately: this run is one sample among several, and the
// pipeline downstream (consolidation, adversarial verification) exists to do
// the filtering. The predecessor's "only report genuine issues" told each
// run to self-censor before the components built to filter ever saw the
// output — paying for coverage and prompting it away.
const SYSTEM_PROMPT = `You are a senior code reviewer. You review one branch at a time, read-only.

This review is one of several independent runs over the same branch. Your findings are merged with the other runs' findings and then adversarially verified, so a wrong finding is caught downstream — but a finding you withhold is gone for good. Report for recall; the pipeline owns precision.

Method:
1. Call list_changed_files first to see the shape of the branch.
2. Read diffs (get_diff) for the files that matter; skip generated or trivial files.
3. When a change's safety depends on code outside the diff, use read_file to check the real context instead of guessing. Use list_files to locate configuration, CI, deploy, environment, or test files by their real paths.
4. When your investigation is complete, stop calling tools and give your final answer: the full review.

Reporting rules:
- Report every issue you genuinely suspect, including ones you could not fully confirm — state your confidence honestly and let verification settle them. Do not pad: an empty findings list is a valid review of a clean branch.
- Severity is impact, confidence is certainty; set them independently. Severity: "critical" = likely bug, data loss, or security hole; "warning" = risky or incomplete; "nit" = style or minor improvement. Confidence: "high" = verified against the code; "medium" = plausible, partially checked; "low" = a suspicion worth a look.
- Every finding names a file; add a line number when you can.
- If a diff came back truncated, say so in the summary rather than treating the unseen part as clean.`;

export interface ReviewRunOptions
{
    model?: string;
    maxTurns?: number;
    // What the change was trying to do — a PR title, a description. The
    // reviewer otherwise judges a diff with no idea of its intent, which is
    // most of what makes a review useful. Free text, caller-supplied: the
    // trigger knows the PR, the CLI usually does not.
    context?: string;
    onProgress?: (event: string) => void;
}

export interface ReviewRunStats
{
    turns: number;
    costUsd: number;
    // The SDK's own totals from the result message — the authoritative view.
    usage: TokenUsage;
    perModel: Record<string, ModelUsage>;
    // Our observational sum over the streamed assistant messages, plus the
    // per-turn detail behind it. May legitimately differ from `usage`;
    // callers report the delta, never act on it.
    streamed: TokenUsage;
    turnUsage: TurnUsage[];
    // Auto-compactions the SDK performed mid-run. Observational, like the
    // rest of this: a run that compacted has had its context rewritten, which
    // is the leading suspect for num_turns outrunning the maxTurns budget.
    compactions: number;
}

// filesChanged rides on both outcomes: a 0-findings run against a 0-file
// diff is a review of nothing, and downstream displays must be able to say
// so instead of presenting it as a clean bill of health.
export type ReviewResult =
    | { status: 'submitted'; review: Review; filesChanged: number; stats: ReviewRunStats }
    | { status: 'aborted'; reason: string; filesChanged: number; stats: ReviewRunStats };

// Which credential wins when both an API key and a subscription login are
// present is undocumented; refuse the ambiguous state so a run can never
// silently bill pay-as-you-go. ANTHROPIC_AUTH_TOKEN sits in the same SDK
// credential list (a gateway/proxy billing path — another way to silently
// not run on subscription) and is refused for the same reason.
// CLAUDE_CODE_OAUTH_TOKEN is the one deliberate exception: it is minted by
// `claude setup-token` against the subscription itself, so headless runs
// stay on subscription credit. Shared by every query()-calling module.
export function assertSubscriptionCredit(): void
{
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
    {
        if (process.env[name] !== undefined && process.env[name] !== '')
        {
            throw new Error(`${name} is set. This reviewer runs on subscription credit only — unset it to continue.`);
        }
    }
}

// An unauthenticated run surfaces as a zero-cost result with subtype
// 'success' but is_error set (observed on SDK 0.3.222: "Not logged in ·
// Please run /login") — the success/error split in `subtype` does not cover
// it, and left alone it dies later as an opaque Zod parse of an absent
// structured_output. Translate it here; the SDK's own advice (/login)
// presumes an interactive terminal, so point headless machines at the token.
export function throwIfErrorResult(result: SDKResultMessage): void
{
    if (result.subtype !== 'success' || !result.is_error)
    {
        return;
    }
    const headless = result.result.includes('Not logged in') && !process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? ' On a headless machine: mint a token with `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN.'
        : '';
    throw new Error(`The run failed without completing: ${result.result}.${headless}`);
}

export async function runReview(client: RepoClient, target: ReviewTarget, opts: ReviewRunOptions = {}): Promise<ReviewResult>
{
    assertSubscriptionCredit();

    // The diff's size is measured before any credit moves — through the
    // tools' own memoized comparison, so the agent's snapshot is the one
    // that was measured and the paginated compare is bought exactly once.
    const tools = createReviewTools(client, target);
    const filesChanged = (await tools.changedFiles()).length;

    // The empty diff is a cost fuse, not just a label: a merged or stale
    // head produces an empty compare, and a full agent run over nothing
    // would bill real credit to report that nothing was there.
    if (filesChanged === 0)
    {
        const zero = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
        return {
            status: 'aborted',
            reason: 'empty-diff',
            filesChanged,
            stats: { turns: 0, costUsd: 0, usage: zero, perModel: {}, streamed: zero, turnUsage: [], compactions: 0 },
        };
    }

    const stream = query({
        prompt: `Review branch "${target.head}" against "${target.base}".`
            + (opts.context !== undefined ? `\n\nWhat this change is meant to do: ${opts.context}` : ''),
        options: {
            systemPrompt: SYSTEM_PROMPT,
            model: opts.model ?? reviewModel(),
            maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
            tools: [],  // no built-ins: the three GitHub tools are the whole world
            mcpServers: { [SERVER_NAME]: tools.server },
            allowedTools: [`mcp__${SERVER_NAME}__*`],
            permissionMode: 'dontAsk',
            outputFormat: { type: 'json_schema', schema: reviewJsonSchema },
        },
    });

    const accumulator = new UsageAccumulator();
    let compactions = 0;
    let result: SDKResultMessage | undefined;
    try
    {
        for await (const message of stream)
        {
            if (message.type === 'assistant')
            {
                accumulator.record(message.message.id, message.message.usage);
                for (const block of message.message.content)
                {
                    if (block.type === 'tool_use')
                    {
                        opts.onProgress?.(`${block.name}(${previewArgs(block.input)})`);
                    }
                }
            }
            else if (message.type === 'system' && message.subtype === 'compact_boundary')
            {
                compactions++;
                const { trigger, pre_tokens: pre } = message.compact_metadata;
                opts.onProgress?.(`[${trigger} compaction at ${pre} tokens]`);
            }
            else if (message.type === 'result')
            {
                result = message;
            }
        }
    }
    catch (error)
    {
        // After an error result (e.g. max turns) the CLI exits non-zero and
        // the SDK errors the stream — but only after yielding the result
        // message, which carries the abort reason and the run's stats. Keep
        // it; rethrow only if we never saw one. An is_error 'success' result
        // (unauthenticated) also errors the stream — prefer our translation
        // of the result over the raw stream error.
        if (result !== undefined)
        {
            throwIfErrorResult(result);
        }
        if (result === undefined || result.subtype === 'success')
        {
            throw error;
        }
    }

    if (result === undefined)
    {
        throw new Error('The SDK stream ended without a result message.');
    }
    throwIfErrorResult(result);

    const stats: ReviewRunStats = {
        turns: result.num_turns,
        costUsd: result.total_cost_usd,
        usage: fromWireUsage(result.usage),
        perModel: result.modelUsage,
        streamed: accumulator.total(),
        turnUsage: accumulator.turns(),
        compactions,
    };

    if (result.subtype !== 'success')
    {
        return { status: 'aborted', reason: result.subtype, filesChanged, stats };
    }

    // The harness already validated against reviewJsonSchema; this parse is
    // the type boundary between `unknown` and Review, not a re-check.
    return { status: 'submitted', review: reviewSchema.parse(result.structured_output), filesChanged, stats };
}

export function previewArgs(input: unknown): string
{
    const json = JSON.stringify(input) ?? '';
    return json.length <= 80 ? json : json.slice(0, 77) + '...';
}
