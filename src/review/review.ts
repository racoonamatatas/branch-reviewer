// The review runner: everything the predecessor's loop.ts did, expressed as
// one query() call. The SDK owns the loop, dispatch, validation, retries, and
// termination; what remains here is wiring, policy, and progress reporting.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelUsage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RepoClient } from '../github/github.js';
import { reviewJsonSchema, reviewSchema } from '../schema/schema.js';
import type { Review } from '../schema/schema.js';
import { createReviewTools, SERVER_NAME } from '../tools/tools.js';
import type { ReviewTarget } from '../tools/tools.js';
import { UsageAccumulator, fromWireUsage } from '../usage/usage.js';
import type { TokenUsage, TurnUsage } from '../usage/usage.js';

const DEFAULT_MAX_TURNS = 20;

// Same prompt as the predecessor except step 4: submit_review no longer
// exists — the harness collects the final response against the output schema.
const SYSTEM_PROMPT = `You are a senior code reviewer. You review one branch at a time, read-only.

Method:
1. Call list_changed_files first to see the shape of the branch.
2. Read diffs (get_diff) for the files that matter; skip generated or trivial files.
3. When a change's safety depends on code outside the diff, use read_file to check the real context instead of guessing.
4. When your investigation is complete, stop calling tools and give your final answer: the full review.

Reporting rules:
- Only report genuine issues; an empty findings list is a valid review of a clean branch.
- Severity: "critical" = likely bug, data loss, or security hole; "warning" = risky or incomplete; "nit" = style or minor improvement.
- Every finding names a file; add a line number when you can.`;

export interface ReviewRunOptions
{
    model?: string;
    maxTurns?: number;
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
}

export type ReviewResult =
    | { status: 'submitted'; review: Review; stats: ReviewRunStats }
    | { status: 'aborted'; reason: string; stats: ReviewRunStats };

export async function runReview(client: RepoClient, target: ReviewTarget, opts: ReviewRunOptions = {}): Promise<ReviewResult>
{
    // Which credential wins when both an API key and a subscription login are
    // present is undocumented; refuse the ambiguous state so a run can never
    // silently bill pay-as-you-go.
    if (process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY !== '')
    {
        throw new Error('ANTHROPIC_API_KEY is set. This reviewer runs on subscription credit only — unset it to continue.');
    }

    const tools = createReviewTools(client, target);

    const stream = query({
        prompt: `Review branch "${target.head}" against "${target.base}".`,
        options: {
            systemPrompt: SYSTEM_PROMPT,
            model: opts.model,
            maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
            tools: [],  // no built-ins: the three GitHub tools are the whole world
            mcpServers: { [SERVER_NAME]: tools.server },
            allowedTools: [`mcp__${SERVER_NAME}__*`],
            permissionMode: 'dontAsk',
            outputFormat: { type: 'json_schema', schema: reviewJsonSchema },
        },
    });

    const accumulator = new UsageAccumulator();
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
        // it; rethrow only if we never saw one.
        if (result === undefined || result.subtype === 'success')
        {
            throw error;
        }
    }

    if (result === undefined)
    {
        throw new Error('The SDK stream ended without a result message.');
    }

    const stats: ReviewRunStats = {
        turns: result.num_turns,
        costUsd: result.total_cost_usd,
        usage: fromWireUsage(result.usage),
        perModel: result.modelUsage,
        streamed: accumulator.total(),
        turnUsage: accumulator.turns(),
    };

    if (result.subtype !== 'success')
    {
        return { status: 'aborted', reason: result.subtype, stats };
    }

    // The harness already validated against reviewJsonSchema; this parse is
    // the type boundary between `unknown` and Review, not a re-check.
    return { status: 'submitted', review: reviewSchema.parse(result.structured_output), stats };
}

function previewArgs(input: unknown): string
{
    const json = JSON.stringify(input) ?? '';
    return json.length <= 80 ? json : json.slice(0, 77) + '...';
}
