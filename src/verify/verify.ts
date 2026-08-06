// The verification agent: the reviewer's shape pointed backwards. Same three
// GitHub read tools, same tooled query(), but the system prompt is an
// adversary trying to refute one occurrence-1 finding against the diff and
// repo. The verdict is three-valued because "couldn't refute" and "refuted"
// are different facts — refutation needs positive contrary evidence, and
// evidence that is unreachable from the repo must surface as undetermined,
// never launder into false.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RepoClient } from '../github/github.js';
import { assertSubscriptionCredit, previewArgs } from '../review/review.js';
import type { Cluster } from '../store/store.js';
import { createReviewTools, SERVER_NAME } from '../tools/tools.js';
import type { ReviewTarget } from '../tools/tools.js';
import { UsageAccumulator, fromWireUsage } from '../usage/usage.js';
import type { TokenUsage } from '../usage/usage.js';

// One finding, not a whole branch — a fraction of the reviewer's budget.
const DEFAULT_MAX_TURNS = 12;

const SYSTEM_PROMPT = `You are an adversarial code-review verifier. Several independent reviews of one branch were consolidated; exactly one of them reported the finding you are given. Your job is to try to refute it against the branch diff and the repository.

Method:
1. Call list_changed_files first to see the shape of the branch.
2. Read the diff (get_diff) of the file the finding names, and of related changed files.
3. Use read_file wherever the finding's truth depends on code outside the diff — callers, definitions, configuration, tests. Actively hunt for evidence that the finding is wrong, not just for evidence that it is right.
4. When your investigation is complete, stop calling tools and give your verdict.

Verdict rules:
- "confirmed": the diff or repository contains evidence that the finding is real.
- "refuted": you found positive contrary evidence — code in this repository that shows the claimed problem cannot occur. Failing to find support for the finding is NOT refutation.
- "undetermined": settling the finding requires evidence not reachable from this repository (runtime behavior, external services, deployment or infrastructure configuration, team intent). Undetermined findings go to a human.
- The rationale must cite the specific evidence you consulted.`;

const verdictSchema = z.enum(['confirmed', 'refuted', 'undetermined'])
    .describe('confirmed: evidence in the diff or repo shows the finding is real. '
        + 'refuted: you found positive contrary evidence in the repo showing the claimed problem cannot occur '
        + '— mere absence of supporting evidence is never refutation. '
        + 'undetermined: the evidence needed to settle this is not reachable from this repo.');

export const verificationResponseSchema = z.object({
    verdict: verdictSchema,
    rationale: z.string()
        .describe('Grounds for the verdict, citing the specific evidence consulted: files read, diff hunks, code paths'),
    confidence: z.string()
        .describe('One sentence: how sure you are, and what evidence could overturn the verdict'),
});

export const verificationResponseJsonSchema = z.toJSONSchema(verificationResponseSchema, { target: 'draft-7' });
export type VerificationResponse = z.infer<typeof verificationResponseSchema>;

// The verify entry point's cluster selection: the unverified singletons.
export function pendingOccurrenceOne(clusters: Cluster[]): Cluster[]
{
    return clusters.filter(c => c.occurrence === 1 && c.verificationStatus === 'pending');
}

export function buildVerificationPrompt(cluster: Cluster, totalRuns: number): string
{
    const f = cluster.representative;
    const line = f.line !== undefined ? `:${f.line}` : '';
    const suggestion = f.suggestion !== undefined ? `\nsuggestion: ${f.suggestion}` : '';
    return `Finding to verify — cluster #${cluster.id}, reported by only 1 of ${totalRuns} independent review runs of this branch (run #${f.runId}):

[${f.severity}] ${f.file}${line} — ${f.title}
${f.detail}${suggestion}

Try to refute this finding against the diff and the repository, then give your verdict.`;
}

export interface VerifyRunOptions
{
    model?: string;
    maxTurns?: number;
    onProgress?: (event: string) => void;
}

export interface VerificationStats
{
    turns: number;
    costUsd: number;
    usage: TokenUsage;
}

export type VerifyResult =
    | { status: 'verified'; response: VerificationResponse; stats: VerificationStats }
    | { status: 'aborted'; reason: string; stats: VerificationStats };

export async function verifyCluster(
    client: RepoClient,
    target: ReviewTarget,
    cluster: Cluster,
    totalRuns: number,
    opts: VerifyRunOptions = {},
): Promise<VerifyResult>
{
    assertSubscriptionCredit();

    // Fresh tools per cluster: the factory memoizes one GitHub comparison
    // per instance, scoped to one agent run by construction.
    const tools = createReviewTools(client, target);

    const stream = query({
        prompt: buildVerificationPrompt(cluster, totalRuns),
        options: {
            systemPrompt: SYSTEM_PROMPT,
            model: opts.model,
            maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
            tools: [],  // no built-ins: the three GitHub tools are the whole world
            mcpServers: { [SERVER_NAME]: tools.server },
            allowedTools: [`mcp__${SERVER_NAME}__*`],
            permissionMode: 'dontAsk',
            outputFormat: { type: 'json_schema', schema: verificationResponseJsonSchema },
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
        // After an error result (e.g. max turns) the SDK errors the stream —
        // but only after yielding the result message, which carries the abort
        // reason and stats. Keep it; rethrow only if we never saw one.
        if (result === undefined || result.subtype === 'success')
        {
            throw error;
        }
    }

    if (result === undefined)
    {
        throw new Error('The SDK stream ended without a result message.');
    }

    const stats: VerificationStats = {
        turns: result.num_turns,
        costUsd: result.total_cost_usd,
        usage: fromWireUsage(result.usage),
    };

    if (result.subtype !== 'success')
    {
        return { status: 'aborted', reason: result.subtype, stats };
    }

    // The harness already validated against the JSON schema; this parse is
    // the type boundary between `unknown` and VerificationResponse.
    return { status: 'verified', response: verificationResponseSchema.parse(result.structured_output), stats };
}
