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
import { consolidateRuns, submittedRunsFor } from '../consolidate/persist.js';
import type { ConsolidationTarget } from '../consolidate/persist.js';
import type { RepoClient } from '../github/github.js';
import { assertSubscriptionCredit, previewArgs, throwIfErrorResult } from '../review/review.js';
import { ReviewStore } from '../store/store.js';
import type { Cluster, Consolidation } from '../store/store.js';
import { createReviewTools, SERVER_NAME } from '../tools/tools.js';
import type { ReviewTarget } from '../tools/tools.js';
import type { ConsolidationId } from '../types/ids.js';
import { UsageAccumulator, fromWireUsage } from '../usage/usage.js';
import type { TokenUsage } from '../usage/usage.js';

// One finding, not a whole branch — a fraction of the reviewer's budget.
const DEFAULT_MAX_TURNS = 12;

const SYSTEM_PROMPT = `You are an adversarial code-review verifier. Several independent reviews of one branch were consolidated; exactly one of them reported the finding you are given. Your job is to try to refute it against the branch diff and the repository.

Method:
1. Call list_changed_files first to see the shape of the branch.
2. Read the diff (get_diff) of the file the finding names, and of related changed files.
3. Use read_file wherever the finding's truth depends on code outside the diff — callers, definitions, configuration, tests. Actively hunt for evidence that the finding is wrong, not just for evidence that it is right.
4. Configuration lives in more than one place. Application config declares defaults; environment templates, deploy manifests, hosting and CI files declare what a deployment actually sets. Check both before concluding that a setting is unpinned or that a default applies — "I found no override" is only true if you looked where overrides live.
5. When your investigation is complete, stop calling tools and give your verdict.

Verdict rules:
- "confirmed": the diff or repository contains evidence that the finding is real.
- "refuted": you found positive contrary evidence — code in this repository that shows the claimed problem cannot occur. Failing to find support for the finding is NOT refutation.
- "undetermined": settling the finding requires evidence not reachable from this repository (runtime behavior, external services, deployment or infrastructure configuration, team intent). Undetermined findings go to a human.
- The rationale must cite the specific evidence you consulted.
- Account for every conditional that guards a path you cite: an early return, a feature flag, a deferral or buffering branch can invert the conclusion, so follow each one to where it rejoins and say in the rationale what you found. A guard you stepped over silently is the most likely way this verdict is wrong.`;

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

// What to adjudicate: findings only one run reported. Already-verified
// clusters are skipped unless reverify is asked for — re-testing a settled
// finding is a calibration act (verdicts have been seen to flip when the
// second run searched different files), so it should be deliberate.
export function verificationQueue(clusters: Cluster[], reverify = false): Cluster[]
{
    return clusters.filter(c => c.occurrence === 1 && (reverify || c.verificationStatus === 'pending'));
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
        // reason and stats. Keep it; rethrow only if we never saw one. An
        // is_error 'success' result (unauthenticated) also errors the stream
        // — prefer our translation of the result over the raw stream error.
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

// Adjudicating a whole consolidation is the verify feature's own orchestration
// — it is where verdicts become rows — so it lives here rather than in one of
// the two entry points that need it. The store is a value import for that
// reason; the prompt and selection functions above stay pure. Reporting is by
// callback, not console: stdout belongs to the CLI layer.
export interface VerifyPendingOptions extends VerifyRunOptions
{
    reverify?: boolean;
    onCluster?: (cluster: Cluster) => void;
    onVerdict?: (cluster: Cluster, response: VerificationResponse, stats: VerificationStats) => void;
    onFailure?: (cluster: Cluster, reason: string) => void;
}

export interface VerifyPendingSummary
{
    attempted: number;
    verified: number;
    failures: number;
    costUsd: number;
}

// Record-and-continue: each verdict is saved as it lands, and a cluster whose
// verification aborts or throws stays pending for a later re-run — append-only
// verdicts make re-running the recovery path.
export async function verifyPending(
    store: ReviewStore,
    client: RepoClient,
    consolidation: Consolidation,
    opts: VerifyPendingOptions = {},
): Promise<VerifyPendingSummary>
{
    const pending = verificationQueue(consolidation.clusters, opts.reverify);
    const target = { base: consolidation.base, head: consolidation.head };
    const totalRuns = consolidation.runIds.length;

    const summary: VerifyPendingSummary = { attempted: pending.length, verified: 0, failures: 0, costUsd: 0 };
    for (const cluster of pending)
    {
        opts.onCluster?.(cluster);
        try
        {
            const result = await verifyCluster(client, target, cluster, totalRuns, opts);
            summary.costUsd += result.stats.costUsd;

            if (result.status === 'aborted')
            {
                summary.failures++;
                opts.onFailure?.(cluster, result.reason);
                continue;
            }

            const { verdict, rationale, confidence } = result.response;
            store.saveVerification({ source: 'agent', clusterId: cluster.id, verdict, rationale, confidence, costUsd: result.stats.costUsd });
            summary.verified++;
            opts.onVerdict?.(cluster, result.response, result.stats);
        }
        catch (error)
        {
            summary.failures++;
            opts.onFailure?.(cluster, error instanceof Error ? error.message : String(error));
        }
    }
    return summary;
}

export interface VerifyTargetOptions extends VerifyRunOptions
{
    reverify?: boolean;
    onEvent?: (event: string) => void;
}

export interface VerifyTargetResult
{
    // Absent only when the target had no findings at all — nothing existed
    // to consolidate, let alone verify.
    consolidationId?: ConsolidationId;
    // True when the latest consolidation already covered every submitted run
    // and was reused instead of paying for a fresh judge call.
    reused: boolean;
    summary: VerifyPendingSummary;
}

// The verify job's runner: make a target's findings verifiable, then face
// them with the adversary. Reuses the latest consolidation when it covers
// exactly the submitted runs — verdicts inherit by member set, so a fresh
// judge call over the same runs would buy nothing — and consolidates first
// otherwise. Throwing on a target with no submitted runs is deliberate — a
// verify job for such a target is a caller mistake, and failing the job
// names it — with one exception: a target whose stored runs all reviewed an
// empty diff succeeds vacuously, because those runs are real and complete.
export async function verifyTarget(
    store: ReviewStore,
    client: RepoClient,
    target: ConsolidationTarget,
    opts: VerifyTargetOptions = {},
): Promise<VerifyTargetResult>
{
    const runs = submittedRunsFor(store, target);
    if (runs.length === 0)
    {
        // A target whose stored runs ALL reviewed an empty diff has nothing
        // to verify but is not a caller mistake — "nothing to verify" is a
        // completed plan, same as the no-findings path below. Every, not
        // some: one empty run must not mask a target whose real attempts all
        // aborted — that target wants a retry, and the throw says so.
        const stored = store.listRuns({ owner: target.owner, repo: target.repo, head: target.head, base: target.base });
        if (stored.length > 0 && stored.every(r => r.status === 'empty'))
        {
            opts.onEvent?.('every stored run of this target reviewed an empty diff — nothing to verify');
            return { reused: false, summary: { attempted: 0, verified: 0, failures: 0, costUsd: 0 } };
        }
        throw new Error('No submitted runs for this target — nothing to verify.');
    }

    // base is pinned in the lookup: the runs above are quad-filtered, so a
    // rev of the same head against a different base must not shadow them.
    const wanted = new Set(runs.map(r => r.id));
    const latest = store.listConsolidations({ owner: target.owner, repo: target.repo, head: target.head, base: target.base })[0];
    const covered = latest !== undefined
        && latest.runIds.length === wanted.size
        && latest.runIds.every(id => wanted.has(id));

    let consolidation: Consolidation | undefined;
    if (covered)
    {
        consolidation = store.getConsolidation(latest.id);
        opts.onEvent?.(`reusing consolidation #${latest.id} — it already covers all ${runs.length} submitted run(s)`);
    }
    else
    {
        opts.onEvent?.(`consolidating ${runs.length} run(s)`);
        consolidation = await consolidateRuns(store, target, runs, opts.model);
        if (consolidation !== undefined)
        {
            opts.onEvent?.(`consolidation #${consolidation.id}: ${consolidation.clusters.length} cluster(s)`);
        }
    }
    if (consolidation === undefined)
    {
        opts.onEvent?.('no findings on any submitted run — nothing to verify');
        return { reused: false, summary: { attempted: 0, verified: 0, failures: 0, costUsd: 0 } };
    }

    const summary = await verifyPending(store, client, consolidation, {
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.reverify !== undefined ? { reverify: opts.reverify } : {}),
        onCluster: cluster => opts.onEvent?.(`verifying cluster #${cluster.id}: ${cluster.representative.title}`),
        onVerdict: (cluster, response, stats) =>
            opts.onEvent?.(`cluster #${cluster.id}: ${response.verdict} ($${stats.costUsd.toFixed(2)})`),
        onFailure: (cluster, reason) => opts.onEvent?.(`cluster #${cluster.id} failed: ${reason}`),
    });
    return { consolidationId: consolidation.id, reused: covered, summary };
}
