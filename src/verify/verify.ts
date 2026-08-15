// The verification agent: the reviewer's shape pointed at one finding. Same
// GitHub read tools, same tooled query(), but the prompt asks for a
// settlement — confirm, refute, or establish unreachability — with equal
// effort in both directions. An earlier draft framed it as an adversary
// ("try to refute", three times over): with the reviewer now recall-first,
// low-confidence findings are the queue's normal diet, and an anchored
// verifier would refute its way through exactly the suspicions the pipeline
// asked the reviewer to voice. The verdict stays three-valued because
// "couldn't refute" and "refuted" are different facts — refutation needs
// positive contrary evidence, and evidence unreachable from the repo must
// surface as undetermined, never launder into false.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { consolidateRuns, submittedRunsFor } from '../consolidate/persist.js';
import type { RepoClient } from '../github/github.js';
import { verifyModel } from '../sdk/models.js';
import { assertSubscriptionCredit, previewArgs, rethrowUnlessResultExplains, requireResult } from '../sdk/sdk.js';
import { ReviewStore } from '../store/store.js';
import type { Cluster, Consolidation } from '../store/store.js';
import { createReviewTools, SERVER_NAME } from '../tools/tools.js';
import type { ReviewTarget } from '../tools/tools.js';
import type { ConsolidationId, RunId } from '../types/ids.js';
import type { Target } from '../types/target.js';
import { fromWireUsage } from '../usage/usage.js';
import type { TokenUsage } from '../usage/usage.js';

// One finding, not a whole branch — but the instruction list asks for the
// diff, callers, definitions, tests, and the places deployments configure
// things. 12 turns aborted real verifications against that list; 24 leaves
// room to actually follow it.
const DEFAULT_MAX_TURNS = 24;

const SYSTEM_PROMPT = `You are a code-review verification agent. Several independent reviews of one branch were consolidated; you are given one finding to settle against the branch diff and the repository. You have no stake in either answer: a wrong confirmation wastes a maintainer's attention, a wrong refutation buries a real bug.

Method:
1. Call list_changed_files first to see the shape of the branch.
2. Read the diff (get_diff) of the file the finding names, and of related changed files.
3. Use read_file wherever the finding's truth depends on code outside the diff — callers, definitions, configuration, tests. Weigh both directions with equal effort: hunt for the guard that would make the claimed problem impossible AND for the concrete path that makes it real.
4. Configuration lives in more than one place. Application config declares defaults; environment templates, deploy manifests, hosting and CI files declare what a deployment actually sets. Use list_files to locate those files by their real paths instead of guessing. "I found no override" is only true if you looked where overrides live.
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

export interface QueuePolicy
{
    // Re-test clusters that already have a verdict — a calibration act
    // (verdicts have been seen to flip when the second run searched
    // different files), so it should be deliberate.
    reverify?: boolean;
    // Verify every pending cluster, corroborated or not: "if I'm reviewing
    // someone else's code, I owe it to them to verify what I say." The gate
    // for anything a human will be handed as fact.
    verifyAll?: boolean;
    // The model that produced a member's run, for the corroboration test.
    // Absent (or returning undefined) falls back to the pre-rotation rule:
    // occurrence alone decides.
    modelOf?: (run: RunId) => string | undefined;
}

// What to adjudicate. Recurrence only earns the skip when it is CROSS-MODEL
// agreement: a claim repeated by one model across rounds is that model
// re-deriving its own prior, not corroboration — proven live when an
// empirically-refuted claim was re-reported for the third time, every
// sighting from the same model, while the other model never made it (rev
// 17). Lapsed clusters re-enter regardless: re-clustering merged new
// evidence into an adjudicated claim. Already-verified clusters are skipped
// unless reverify is asked for.
export function verificationQueue(clusters: Cluster[], policy: QueuePolicy = {}): Cluster[]
{
    const corroborated = (c: Cluster): boolean =>
    {
        if (policy.modelOf === undefined)
        {
            return c.occurrence > 1;
        }
        const models = new Set(c.members.map(m => policy.modelOf!(m.runId)).filter(m => m !== undefined));
        return models.size >= 2;
    };
    return clusters.filter(c =>
        (policy.reverify === true || c.verificationStatus === 'pending')
        && (policy.verifyAll === true || c.lapsedVerdict !== undefined || !corroborated(c)));
}

// The verifier sees everything the pipeline knows about the defect: every
// run's phrasing (different angles on the same problem are evidence in
// themselves), the reviewer's own confidence, and the occurrence odds stated
// as fact rather than as a nudge toward either verdict.
export function buildVerificationPrompt(cluster: Cluster, totalRuns: number): string
{
    const f = cluster.representative;
    const line = f.line !== undefined ? `:${f.line}` : '';
    const suggestion = f.suggestion !== undefined ? `\nsuggestion: ${f.suggestion}` : '';
    const confidence = f.confidence !== undefined ? `\nreviewer confidence: ${f.confidence}` : '';
    const others = cluster.members.filter(m => m.id !== f.id);
    const phrasings = others.length === 0
        ? ''
        : `\n\nOther runs reported the same defect as:\n${others.map((m) =>
        {
            const memberLine = m.line !== undefined ? `:${m.line}` : '';
            return `- (run #${m.runId}) ${m.file}${memberLine} — ${m.title}: ${m.detail}`;
        }).join('\n')}`;
    const lapsed = cluster.lapsedVerdict === undefined
        ? ''
        : `\n\nAn earlier adjudication of part of this group ended "${cluster.lapsedVerdict}", before re-clustering merged in new reports. That verdict no longer applies — the merged group is a different claim. Treat it as context, weigh the new reports, and settle the whole group afresh.`;
    return `Finding to verify — cluster #${cluster.id}, reported by ${cluster.occurrence} of ${totalRuns} independent review runs of this branch (representative from run #${f.runId}):

[${f.severity}] ${f.file}${line} — ${f.title}
${f.detail}${suggestion}${confidence}${phrasings}${lapsed}

Settle this finding against the diff and the repository, then give your verdict.`;
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
            model: opts.model ?? verifyModel(),
            maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
            tools: [],  // no built-ins: the three GitHub tools are the whole world
            mcpServers: { [SERVER_NAME]: tools.server },
            allowedTools: [`mcp__${SERVER_NAME}__*`],
            permissionMode: 'dontAsk',
            outputFormat: { type: 'json_schema', schema: verificationResponseJsonSchema },
        },
    });

    let seen: SDKResultMessage | undefined;
    try
    {
        for await (const message of stream)
        {
            if (message.type === 'assistant')
            {
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
                seen = message;
            }
        }
    }
    catch (error)
    {
        rethrowUnlessResultExplains(seen, error);
    }
    const result = requireResult(seen);

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
    verifyAll?: boolean;
    // Polled before each cluster fires. Every cluster is its own paid call,
    // so a shutdown mid-queue must stop at the next boundary instead of
    // billing the whole tail (a SIGTERM'd verification pass kept spending
    // per pending cluster — rev 17). Verdicts already recorded stay saved.
    shouldStop?: () => boolean;
    // The per-cluster runner, injectable so the record-and-continue loop is
    // testable without burning credit — the same seam WorkerDeps gives the
    // job runners. Production callers omit it.
    runner?: typeof verifyCluster;
    onCluster?: (cluster: Cluster) => void;
    onVerdict?: (cluster: Cluster, response: VerificationResponse, stats: VerificationStats) => void;
    onFailure?: (cluster: Cluster, reason: string) => void;
}

export interface VerifyPendingSummary
{
    // What the queue held and what was actually faced: `queued` is the
    // "how much work existed" signal, `attempted` counts clusters the loop
    // reached — they differ exactly when a stop signal cut the pass short.
    queued: number;
    attempted: number;
    verified: number;
    failures: number;
    costUsd: number;
    // A stop signal cut the queue short: the summary describes an incomplete
    // pass, and the caller must not report a completed plan.
    stopped?: boolean;
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
    // The corroboration test needs to know which model produced each run;
    // the runs are already local rows, so this costs no network.
    const runModels = new Map<RunId, string>();
    for (const id of consolidation.runIds)
    {
        const run = store.getRun(id);
        if (run !== undefined)
        {
            runModels.set(id, run.model);
        }
    }
    const pending = verificationQueue(consolidation.clusters, {
        ...(opts.reverify !== undefined ? { reverify: opts.reverify } : {}),
        ...(opts.verifyAll !== undefined ? { verifyAll: opts.verifyAll } : {}),
        modelOf: id => runModels.get(id),
    });
    const target = { base: consolidation.base, head: consolidation.head };
    const totalRuns = consolidation.runIds.length;

    const run = opts.runner ?? verifyCluster;
    const summary: VerifyPendingSummary = { queued: pending.length, attempted: 0, verified: 0, failures: 0, costUsd: 0 };
    for (const cluster of pending)
    {
        if (opts.shouldStop?.() === true)
        {
            summary.stopped = true;
            break;
        }
        summary.attempted++;
        opts.onCluster?.(cluster);
        try
        {
            const result = await run(client, target, cluster, totalRuns, opts);
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
    verifyAll?: boolean;
    // Forwarded to the per-cluster loop; see VerifyPendingOptions.
    shouldStop?: () => boolean;
    // For the consolidate-if-needed step; unset, the judge falls to its own
    // default rather than inheriting the verifier's model.
    judgeModel?: string;
    // Injectable stages: `consolidate` guards the one paid judge call this
    // gate exists to avoid, `runner` is the per-cluster verifier. Testable
    // without credit; production callers omit both.
    consolidate?: typeof consolidateRuns;
    runner?: typeof verifyCluster;
    onEvent?: (event: string) => void;
}

export interface VerifyTargetResult
{
    // Absent only when the target had no findings at all — nothing existed
    // to consolidate, let alone verify.
    consolidationId?: ConsolidationId;
    summary: VerifyPendingSummary;
}

// The verify job's runner: make a target's findings verifiable, then face
// them with the adversary. Reuses the latest consolidation when it covers
// exactly the submitted runs — verdicts inherit by member set, so a fresh
// judge call over the same runs would buy nothing — and consolidates first
// otherwise. Throwing on a target with no submitted runs is deliberate: a
// verify job for such a target is a caller mistake, and failing the job
// names it.
export async function verifyTarget(
    store: ReviewStore,
    client: RepoClient,
    target: Target,
    opts: VerifyTargetOptions = {},
): Promise<VerifyTargetResult>
{
    const runs = submittedRunsFor(store, target);
    if (runs.length === 0)
    {
        throw new Error('No submitted runs for this target — nothing to verify.');
    }

    // The quad filter matters here: the runs above are filtered by base, so a
    // consolidation of the same head against a different base must not be
    // mistaken for coverage.
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
        const consolidate = opts.consolidate ?? consolidateRuns;
        consolidation = await consolidate(store, target, runs, {
            ...(opts.judgeModel !== undefined ? { model: opts.judgeModel } : {}),
            onDegraded: violation => opts.onEvent?.(
                `clustering degraded (${violation}) — proceeding with one cluster per finding`),
        });
        if (consolidation !== undefined)
        {
            opts.onEvent?.(`consolidation #${consolidation.id}: ${consolidation.clusters.length} cluster(s)`);
        }
    }
    if (consolidation === undefined)
    {
        opts.onEvent?.('no findings on any submitted run — nothing to verify');
        return { summary: { queued: 0, attempted: 0, verified: 0, failures: 0, costUsd: 0 } };
    }

    const summary = await verifyPending(store, client, consolidation, {
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.reverify !== undefined ? { reverify: opts.reverify } : {}),
        ...(opts.verifyAll !== undefined ? { verifyAll: opts.verifyAll } : {}),
        ...(opts.shouldStop !== undefined ? { shouldStop: opts.shouldStop } : {}),
        ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
        onCluster: cluster => opts.onEvent?.(`verifying cluster #${cluster.id}: ${cluster.representative.title}`),
        onVerdict: (cluster, response, stats) =>
            opts.onEvent?.(`cluster #${cluster.id}: ${response.verdict} ($${stats.costUsd.toFixed(2)})`),
        onFailure: (cluster, reason) => opts.onEvent?.(`cluster #${cluster.id} failed: ${reason}`),
    });
    return { consolidationId: consolidation.id, summary };
}
