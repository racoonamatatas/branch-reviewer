// A campaign: review one target repeatedly until the runs stop finding new
// things, then verify what only one run saw. Six reviews of the same branch
// proved single runs are samples, not surveys — the 4th contributed the best
// finding of the project — so the trustworthy artifact is a union, and the
// open question was only ever "how many more runs?". The tool answers it:
// rounds fire back-to-back in one process (they ride each other's prompt
// cache), each round re-consolidates every stored run of the target, and
// coverage reports what is probably still unseen while barren rounds decide
// when to stop.

import { consolidateRuns, submittedRunsFor } from '../consolidate/persist.js';
import { coverageOf, novelClusters, shouldContinue } from '../coverage/coverage.js';
import type { Coverage } from '../coverage/coverage.js';
import type { RepoClient } from '../github/github.js';
import { runReview } from '../review/review.js';
import { ReviewStore } from '../store/store.js';
import type { Consolidation } from '../store/store.js';
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
    // The judge retried into the identity-partition fallback — the
    // consolidation is valid but degenerate (occurrence 1 everywhere).
    onJudgeDegraded?: (violation: string) => void;
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
    consolidationFailed?: string;  // the judge threw; the round's run still joined the union
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
    // campaign's own contribution is only measurable against them. A baseline
    // the judge cannot produce is forfeited, not fatal — the first round's
    // consolidation supersedes it, and no review credit has moved yet.
    let latest: Consolidation | undefined;
    try
    {
        latest = await consolidateTarget(store, target, opts);
    }
    catch
    {
        latest = undefined;
    }
    if (latest !== undefined)
    {
        opts.onBaseline?.(latest.id, coverageOf(verifiableClusters(latest)));
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
                filesChanged: result.filesChanged,
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

        // The review is paid for and saved by this point, so a judge failure
        // must not throw the campaign away: the run stays in the union, the
        // round just cannot measure its own yield. No consolidationId keeps
        // it out of shouldContinue's input — a judge outage neither counts
        // barren nor resets patience.
        try
        {
            const consolidation = await consolidateTarget(store, target, opts);
            if (consolidation !== undefined)
            {
                latest = consolidation;
                outcome.consolidationId = consolidation.id;
                outcome.coverage = coverageOf(verifiableClusters(consolidation));
                outcome.novelClusters = novelClusters(consolidation.clusters, outcome.runId!);
            }
        }
        catch (error)
        {
            outcome.consolidationFailed = error instanceof Error ? error.message : String(error);
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

// Refuted clusters leave the estimator's input: a disproven claim is not a
// discovered finding. Verdicts inherit across consolidations by member set,
// so mid-campaign refutations from earlier passes still apply here.
function verifiableClusters(consolidation: Consolidation): Consolidation['clusters']
{
    return consolidation.clusters.filter(c => c.verificationStatus !== 'refuted');
}

// Every stored submitted run of this target, re-clustered (the mechanics
// live in consolidate/persist). Undefined when fewer than two are available:
// the campaign's guard, not the mechanism's — occurrence counts, and
// therefore coverage, only mean something to the loop across runs.
async function consolidateTarget(
    store: ReviewStore,
    target: CampaignTarget,
    opts: CampaignOptions,
): Promise<Consolidation | undefined>
{
    const runs = submittedRunsFor(store, target);
    if (runs.length < 2)
    {
        return undefined;
    }
    return consolidateRuns(store, target, runs, {
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.onJudgeDegraded !== undefined ? { onDegraded: opts.onJudgeDegraded } : {}),
    });
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
