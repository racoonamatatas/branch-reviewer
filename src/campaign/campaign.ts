// A campaign: review one target repeatedly until the runs stop finding new
// things, then verify what only one run saw. Six reviews of the same branch
// proved single runs are samples, not surveys — the 4th contributed the best
// finding of the project — so the trustworthy artifact is a union, and the
// open question was only ever "how many more runs?". The tool answers it:
// rounds fire back-to-back in one process (they ride each other's prompt
// cache), each round re-consolidates every stored run of the target, and
// coverage reports what is probably still unseen while barren rounds decide
// when to stop.

import { runClustering, distinctRuns, maxSeverity } from '../consolidate/consolidate.js';
import { coverageOf, novelClusters, shouldContinue } from '../coverage/coverage.js';
import type { Coverage } from '../coverage/coverage.js';
import type { RepoClient } from '../github/github.js';
import { runReview } from '../review/review.js';
import { ReviewStore } from '../store/store.js';
import type { Consolidation, Finding, Run } from '../store/store.js';
import type { ConsolidationId, RunId } from '../types/ids.js';
import { verifyPending } from '../verify/verify.js';
import type { VerifyPendingOptions, VerifyPendingSummary } from '../verify/verify.js';

// Two aborts in a row is the SDK telling us something structural; burning the
// rest of the run cap on it is waste, not diligence.
const ABORT_TOLERANCE = 2;

export interface CampaignTarget
{
    owner: string;
    repo: string;
    head: string;
    base: string;
}

export interface CampaignOptions
{
    maxRuns: number;
    model?: string;
    maxTurns?: number;
    patience?: number;
    verify: boolean;
    reverify?: boolean;
    onRoundStart?: (round: number, of: number) => void;
    onReviewProgress?: (event: string) => void;
    onRun?: (outcome: RoundOutcome) => void;
    onBaseline?: (consolidationId: ConsolidationId, coverage: Coverage) => void;
    verifyReporting?: VerifyPendingOptions;
}

export interface RoundOutcome
{
    round: number;
    runId?: RunId;      // absent when the review threw before anything could be stored
    findings: number;
    turns: number;
    costUsd: number;
    aborted?: string;   // the SDK ended the run early (max turns)
    failed?: string;    // the round threw — network, API, or a save that did not land
    consolidationId?: ConsolidationId;
    coverage?: Coverage;
    novelClusters: number;  // clusters only this run reported — the round's marginal yield
}

export type StoppedBy = 'dry' | 'max-runs' | 'no-usable-runs';

export interface CampaignResult
{
    rounds: RoundOutcome[];
    consolidationId?: ConsolidationId;
    runIds: RunId[];  // every run in the final consolidation, not just this campaign's
    reviewCostUsd: number;
    verification?: VerifyPendingSummary;
    stoppedBy: StoppedBy;
}

export async function runCampaign(
    store: ReviewStore,
    client: RepoClient,
    target: CampaignTarget,
    opts: CampaignOptions,
): Promise<CampaignResult>
{
    const reviewTarget = { base: target.base, head: target.head };
    const rounds: RoundOutcome[] = [];
    let reviewCostUsd = 0;
    let consecutiveAborts = 0;
    let stoppedBy: StoppedBy = 'max-runs';

    // Runs already stored for this target are part of the union, so the
    // campaign's own contribution is only measurable against them.
    const baseline = await consolidateTarget(store, target, opts.model);
    let latest = baseline;
    if (baseline !== undefined)
    {
        opts.onBaseline?.(baseline.id, coverageOf(baseline.clusters));
    }

    for (let round = 1; round <= opts.maxRuns; round++)
    {
        opts.onRoundStart?.(round, opts.maxRuns);

        const outcome: RoundOutcome = { round, findings: 0, turns: 0, costUsd: 0, novelClusters: 0 };
        try
        {
            const result = await runReview(client, reviewTarget, {
                model: opts.model,
                ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
                ...(opts.onReviewProgress !== undefined ? { onProgress: opts.onReviewProgress } : {}),
            });
            reviewCostUsd += result.stats.costUsd;
            outcome.turns = result.stats.turns;
            outcome.costUsd = result.stats.costUsd;
            outcome.findings = result.status === 'submitted' ? result.review.findings.length : 0;

            // Unlike a single review — where a failed save is observational and
            // only warns — a run the campaign cannot store cannot join the
            // union, so a save failure ends the round rather than silently
            // shrinking the evidence the stopping decision rests on.
            outcome.runId = store.saveRun({
                owner: target.owner,
                repo: target.repo,
                head: target.head,
                base: target.base,
                model: opts.model ?? 'default',
                status: result.status === 'submitted' ? 'submitted' : 'aborted',
                ...(result.status === 'aborted' ? { reason: result.reason } : { review: result.review }),
                turns: result.stats.turns,
                costUsd: result.stats.costUsd,
                usage: result.stats.usage,
            });

            if (result.status === 'aborted')
            {
                outcome.aborted = result.reason;
            }
        }
        catch (error)
        {
            // A transient failure must not discard rounds already paid for:
            // the round is recorded as failed and the loop decides whether to
            // keep going, so the campaign still reports and consolidates.
            outcome.failed = error instanceof Error ? error.message : String(error);
        }

        // An unusable round costs a slot but says nothing about saturation, so
        // it never feeds the barren-round rule; two in a row is structural.
        if (outcome.aborted !== undefined || outcome.failed !== undefined)
        {
            rounds.push(outcome);
            opts.onRun?.(outcome);
            consecutiveAborts++;
            if (consecutiveAborts >= ABORT_TOLERANCE)
            {
                stoppedBy = 'no-usable-runs';
                break;
            }
            continue;
        }
        consecutiveAborts = 0;

        const consolidation = await consolidateTarget(store, target, opts.model);
        if (consolidation !== undefined)
        {
            latest = consolidation;
            outcome.consolidationId = consolidation.id;
            outcome.coverage = coverageOf(consolidation.clusters);
            outcome.novelClusters = novelClusters(consolidation.clusters, outcome.runId!);
        }
        rounds.push(outcome);
        opts.onRun?.(outcome);

        if (!shouldContinue(rounds.filter(r => r.consolidationId !== undefined), opts.patience))
        {
            stoppedBy = 'dry';
            break;
        }
    }

    const campaign: CampaignResult = {
        rounds,
        ...(latest !== undefined ? { consolidationId: latest.id, runIds: latest.runIds } : { runIds: [] }),
        reviewCostUsd,
        stoppedBy,
    };

    if (opts.verify && latest !== undefined)
    {
        const consolidation = store.getConsolidation(latest.id)!;
        campaign.verification = await verifyPending(store, client, consolidation, {
            model: opts.model,
            ...(opts.reverify !== undefined ? { reverify: opts.reverify } : {}),
            ...opts.verifyReporting,
        });
    }

    return campaign;
}

// Every stored submitted run of this target, re-clustered. Undefined when
// fewer than two are available: occurrence counts — and therefore coverage —
// only mean something across runs.
async function consolidateTarget(
    store: ReviewStore,
    target: CampaignTarget,
    model?: string,
): Promise<Consolidation | undefined>
{
    const runs = runsForTarget(store, target);
    if (runs.length < 2)
    {
        return undefined;
    }

    const findings: Finding[] = runs.flatMap(run => store.getFindings(run.id));
    if (findings.length === 0)
    {
        return undefined;
    }

    const proposals = await runClustering(findings, { model });
    const byId = new Map(findings.map(f => [f.id, f]));
    const id = store.saveConsolidation({
        owner: target.owner,
        repo: target.repo,
        head: target.head,
        base: target.base,
        runIds: runs.map(run => run.id),
        clusters: proposals.map((proposal) =>
        {
            const members = proposal.memberIds.map(memberId => byId.get(memberId)!);
            return {
                memberIds: proposal.memberIds,
                representativeId: proposal.representativeId,
                severity: maxSeverity(members.map(m => m.severity)),
                occurrence: distinctRuns(members),
            };
        }),
    });

    // Read back rather than trust the in-memory proposal: the stored rows are
    // what every later step (coverage, verification, the report) sees.
    return store.getConsolidation(id)!;
}

function runsForTarget(store: ReviewStore, target: CampaignTarget): Run[]
{
    const runs: Run[] = [];
    for (const summary of store.listRuns())
    {
        if (summary.status !== 'submitted')
        {
            continue;
        }
        const run = store.getRun(summary.id);
        if (run !== undefined
            && run.owner === target.owner && run.repo === target.repo
            && run.head === target.head && run.base === target.base)
        {
            runs.push(run);
        }
    }
    // listRuns is newest-first; consolidation reads better in run order.
    return runs.reverse();
}

export function clusterGrowth(rounds: RoundOutcome[]): Array<{ round: number; novelClusters: number }>
{
    return rounds
        .filter(r => r.consolidationId !== undefined)
        .map(r => ({ round: r.round, novelClusters: r.novelClusters }));
}

export function campaignCost(campaign: CampaignResult): { reviews: number; verification: number; total: number }
{
    const verification = campaign.verification?.costUsd ?? 0;
    return { reviews: campaign.reviewCostUsd, verification, total: campaign.reviewCostUsd + verification };
}
