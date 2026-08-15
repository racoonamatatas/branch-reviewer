// A campaign: review one target repeatedly until the runs stop finding new
// things, then verify what only one run saw. Six reviews of the same branch
// proved single runs are samples, not surveys — the 4th contributed the best
// finding of the project — so the trustworthy artifact is a union, and the
// open question was only ever "how many more runs?". The tool answers it:
// rounds fire back-to-back in one process (they ride each other's prompt
// cache), each round re-consolidates every stored run of the target, and
// coverage reports what is probably still unseen while barren rounds decide
// when to stop.

import { ClusteringError } from '../consolidate/consolidate.js';
import { consolidateRuns, submittedRunsFor } from '../consolidate/persist.js';
import { coverageOf, novelClusters, shouldContinue, verifiableClusters } from '../coverage/coverage.js';
import type { Coverage } from '../coverage/coverage.js';
import type { RepoClient } from '../github/github.js';
import { lensFor } from '../review/lenses.js';
import { runReview } from '../review/review.js';
import { ReviewStore } from '../store/store.js';
import type { Consolidation } from '../store/store.js';
import type { ConsolidationId, RunId } from '../types/ids.js';
import type { Target } from '../types/target.js';
import { verifyPending } from '../verify/verify.js';
import type { VerifyPendingOptions, VerifyPendingSummary } from '../verify/verify.js';

// Two aborts in a row is the SDK telling us something structural; burning the
// rest of the run cap on it is waste, not diligence.
const ABORT_TOLERANCE = 2;

// The stage runners, injectable so the loop that decides when to stop
// burning credit is testable without burning any — the same seam WorkerDeps
// gives the job runners. Production callers omit them.
export interface CampaignRunners
{
    review?: typeof runReview;
    consolidate?: typeof consolidateRuns;
    verifyPending?: typeof verifyPending;
}

export interface CampaignOptions
{
    maxRuns: number;
    model?: string;
    // Diversity knobs. Chao1 assumes independent samples and identical
    // rounds are anything but — same model, same prompt, same walk through
    // the same files. Rotating a lens into each round's prompt (on by
    // default: it redistributes attention, not budget) and cycling the
    // review model (opt-in: it changes what bills) are how the campaign
    // manufactures the independence the estimator wants, and cross-model
    // agreement is a stronger confirmation signal than one model repeating
    // itself. `models` cycles per round and overrides `model`; rotation
    // forfeits cross-round cache sharing between different models — purely a
    // cost, not a statistical loss: identical inputs are the correlation,
    // and the cache only ever certified that rounds were identical.
    models?: string[];
    rotateLenses?: boolean;
    // Role overrides; unset, the judge and verifier fall to their own
    // defaults (src/sdk/models.ts) rather than inheriting the reviewer's.
    judgeModel?: string;
    verifyModel?: string;
    maxTurns?: number;
    patience?: number;
    verify: boolean;
    reverify?: boolean;
    // Verify every pending cluster at the end, not just the uncorroborated
    // ones — the posture for findings a human will be handed as fact.
    verifyAll?: boolean;
    // Polled before each round fires and before the final verification pass.
    // A campaign is not one paid call, it is a plan for many — "let the
    // in-flight job finish" must mean the round already billing, not every
    // round the plan still intends (the smoke review confirmed a SIGTERM'd
    // campaign kept spending for its full run cap). Completed rounds stay
    // saved and consolidated.
    shouldStop?: () => boolean;
    onRoundStart?: (round: number, of: number, lens?: string, model?: string) => void;
    onReviewProgress?: (event: string) => void;
    onRun?: (outcome: RoundOutcome) => void;
    onBaseline?: (consolidationId: ConsolidationId, coverage: Coverage) => void;
    // The judge retried into the identity-partition fallback — the
    // consolidation is valid but degenerate (occurrence 1 everywhere).
    onJudgeDegraded?: (violation: string) => void;
    // The baseline consolidation is forfeitable, not silent: a throw there
    // often heralds a misconfiguration about to kill every round, and the
    // operator deserves the message before the first review bills.
    onBaselineFailed?: (error: string) => void;
    // Callbacks only, deliberately: the full VerifyPendingOptions carries
    // model/reverify/runner, and spreading those would override the
    // campaign's own deliberate choices below (smoke rev 14, confirmed).
    verifyReporting?: Pick<VerifyPendingOptions, 'onCluster' | 'onVerdict' | 'onFailure'>;
    runners?: CampaignRunners;
}

export interface RoundOutcome
{
    round: number;
    runId?: RunId;      // absent when the review threw before anything could be stored
    lens?: string;      // the rotation's focus this round; absent = generalist
    model?: string;     // resolved review model, when the caller chose one
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

export type StoppedBy = 'dry' | 'max-runs' | 'no-usable-runs' | 'stopped';

export interface CampaignResult
{
    rounds: RoundOutcome[];
    consolidationId?: ConsolidationId;
    runIds: RunId[];  // every run in the final consolidation, not just this campaign's
    reviewCostUsd: number;
    // Judge calls this campaign fired (baseline + one per usable round),
    // metered so the headline number stops excluding half the spend.
    judgeCostUsd: number;
    verification?: VerifyPendingSummary;
    stoppedBy: StoppedBy;
}

export async function runCampaign(
    store: ReviewStore,
    client: RepoClient,
    target: Target,
    opts: CampaignOptions,
): Promise<CampaignResult>
{
    const review = opts.runners?.review ?? runReview;
    const verify = opts.runners?.verifyPending ?? verifyPending;
    const reviewTarget = { base: target.base, head: target.head };
    const rounds: RoundOutcome[] = [];
    let reviewCostUsd = 0;
    let judgeCostUsd = 0;
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
    catch (error)
    {
        latest = undefined;
        // A failed judge call still billed its attempts; the error carries
        // the meter so the headline number stays honest (rev 21).
        if (error instanceof ClusteringError)
        {
            judgeCostUsd += error.costUsd;
        }
        opts.onBaselineFailed?.(error instanceof Error ? error.message : String(error));
    }
    if (latest !== undefined)
    {
        judgeCostUsd += latest.costUsd ?? 0;
        opts.onBaseline?.(latest.id, coverageOf(verifiableClusters(latest.clusters)));
    }

    for (let round = 1; round <= opts.maxRuns; round++)
    {
        if (opts.shouldStop?.() === true)
        {
            stoppedBy = 'stopped';
            break;
        }

        // The round's slice of the rotation. Lenses cycle unless switched
        // off; models cycle only when a list was given. Both are functions
        // of the round number alone, so an unusable round still consumes
        // its slot — determinism over backfilling.
        const lens = (opts.rotateLenses ?? true) ? lensFor(round) : undefined;
        const model = opts.models !== undefined && opts.models.length > 0
            ? opts.models[(round - 1) % opts.models.length]!
            : opts.model;
        opts.onRoundStart?.(round, opts.maxRuns, lens?.name, model);

        const outcome: RoundOutcome = {
            round, findings: 0, turns: 0, costUsd: 0, novelClusters: 0,
            ...(lens !== undefined ? { lens: lens.name } : {}),
            ...(model !== undefined ? { model } : {}),
        };
        try
        {
            const result = await review(client, reviewTarget, {
                model,
                ...(lens !== undefined ? { lens } : {}),
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
                model: model ?? 'default',
                ...(lens !== undefined ? { lens: lens.name } : {}),
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
                judgeCostUsd += consolidation.costUsd ?? 0;
                outcome.consolidationId = consolidation.id;
                outcome.coverage = coverageOf(verifiableClusters(consolidation.clusters));
                outcome.novelClusters = novelClusters(consolidation.clusters, outcome.runId!);
            }
        }
        catch (error)
        {
            if (error instanceof ClusteringError)
            {
                judgeCostUsd += error.costUsd;
            }
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

    // Verification is its own string of paid calls, so the stop signal
    // gates it exactly like a round — but the gate is delegated, never
    // pre-empted: the per-cluster guard in verifyPending bills nothing when
    // the signal is already up, and it alone knows whether anything was
    // actually left to verify. A cut-short pass surfaces as 'stopped' (a
    // shutdown during the final round otherwise reads as a succeeded
    // campaign whose verification silently never ran — rev 17), while a
    // shutdown over an empty queue stays a completed plan (rev 19).
    let verification: VerifyPendingSummary | undefined;
    if (opts.verify && latest !== undefined)
    {
        // `latest` is already the read-back entity consolidateRuns
        // returned — fresh rows, inherited statuses and all. No re-read.
        verification = await verify(store, client, latest, {
            model: opts.verifyModel ?? opts.model,
            ...(opts.reverify !== undefined ? { reverify: opts.reverify } : {}),
            ...(opts.verifyAll !== undefined ? { verifyAll: opts.verifyAll } : {}),
            ...(opts.shouldStop !== undefined ? { shouldStop: opts.shouldStop } : {}),
            ...opts.verifyReporting,
        });
        if (verification.stopped === true)
        {
            stoppedBy = 'stopped';
        }
    }

    return {
        rounds,
        ...(latest !== undefined ? { consolidationId: latest.id, runIds: latest.runIds } : { runIds: [] }),
        reviewCostUsd,
        judgeCostUsd,
        ...(verification !== undefined ? { verification } : {}),
        stoppedBy,
    };
}

// Every stored submitted run of this target, re-clustered (the mechanics
// live in consolidate/persist). Undefined when fewer than two are available:
// the campaign's guard, not the mechanism's — occurrence counts, and
// therefore coverage, only mean something to the loop across runs.
async function consolidateTarget(
    store: ReviewStore,
    target: Target,
    opts: CampaignOptions,
): Promise<Consolidation | undefined>
{
    const runs = submittedRunsFor(store, target);
    if (runs.length < 2)
    {
        return undefined;
    }
    const consolidate = opts.runners?.consolidate ?? consolidateRuns;
    return consolidate(store, target, runs, {
        ...(opts.judgeModel !== undefined ? { model: opts.judgeModel } : {}),
        ...(opts.onJudgeDegraded !== undefined ? { onDegraded: opts.onJudgeDegraded } : {}),
    });
}

export function clusterGrowth(rounds: RoundOutcome[]): Array<{ round: number; novelClusters: number }>
{
    return rounds
        .filter(r => r.consolidationId !== undefined)
        .map(r => ({ round: r.round, novelClusters: r.novelClusters }));
}

export function campaignCost(campaign: CampaignResult): { reviews: number; judge: number; verification: number; total: number }
{
    const verification = campaign.verification?.costUsd ?? 0;
    return {
        reviews: campaign.reviewCostUsd,
        judge: campaign.judgeCostUsd,
        verification,
        total: campaign.reviewCostUsd + campaign.judgeCostUsd + verification,
    };
}
