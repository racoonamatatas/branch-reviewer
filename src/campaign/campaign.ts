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
import { runReview } from '../review/review.js';
import { acquireCampaignLease } from '../store/lease.js';
import type { Lease } from '../store/lease.js';
import { DuplicateCampaignError, ReviewStore } from '../store/store.js';
import type { Consolidation, StoppedBy } from '../store/store.js';
import type { CampaignId, ConsolidationId, RunId } from '../types/ids.js';
import type { Target } from '../types/target.js';
import { verifyPending } from '../verify/verify.js';
import type { VerifyPendingOptions, VerifyPendingSummary } from '../verify/verify.js';
import { nextRound } from './rotation.js';
import type { RotationSample } from './rotation.js';

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
    // Fires once the campaign's own record exists — callers that outlive this
    // process (the worker's job row, the CLI's Ctrl-C handler) need the id to
    // point at it.
    onCampaign?: (id: CampaignId) => void;
    // A campaign-record write that failed; the loop reported it and moved on.
    onWarning?: (message: string) => void;
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
    consolidationFailed?: string;  // the run saved but the judge threw — the run still joined the union, no consolidation this round
    consolidationId?: ConsolidationId;
    coverage?: Coverage;
    novelClusters: number;  // clusters only this run reported — the round's marginal yield
}

// StoppedBy moved to the store when campaigns became persisted (it is stored
// vocabulary now, like JobState); re-exported so campaign consumers keep one
// import for the loop's whole result surface.
export type { StoppedBy } from '../store/store.js';

export interface CampaignResult
{
    // Absent only when the campaign record itself could not be created —
    // persistence is observational, so the loop ran anyway.
    campaignId?: CampaignId;
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
    // The duplicate gate lives inside createCampaign (atomic under SQLite's
    // writer lock — a pre-check here was check-then-act, run-60 finding) and
    // its typed refusal escapes the recorder's observational guard: the
    // worker maps the throw to a failed job, the CLI to exit 1, and no
    // credit moves. A wedged live row (liveness unprovable) blocks this
    // too; the operator's way out is `--force-fail <id>`.
    const review = opts.runners?.review ?? runReview;
    const verify = opts.runners?.verifyPending ?? verifyPending;
    const reviewTarget = { base: target.base, head: target.head };
    const rounds: RoundOutcome[] = [];
    let reviewCostUsd = 0;
    let judgeCostUsd = 0;
    let consecutiveAborts = 0;
    let consecutiveJudgeFailures = 0;
    let stoppedBy: StoppedBy = 'max-runs';
    let latest: Consolidation | undefined;

    // The campaign's own record opens before the baseline judge call — the
    // loop is visible as a campaign from the moment it starts, not once it
    // has something to show. Every write through the recorder is
    // observational: the runs and consolidations are the evidence and have
    // their own stricter rules; this row is the narrative, and a failed
    // write must warn, never kill a loop that is billing credit.
    const recorder = new CampaignRecorder(store, opts.onWarning);
    const campaignId = recorder.create(target);

    // Rounds land in three places (the result, the record, the caller) and
    // must never drift apart — one helper, three exits from the loop.
    const record = (outcome: RoundOutcome): void =>
    {
        rounds.push(outcome);
        recorder.round(outcome);
        opts.onRun?.(outcome);
    };

    try
    {
        // Inside the try on purpose: a throwing listener reaches the same
        // catch as any structural failure, so the record is failed and the
        // lease released instead of both dangling on a callback bug.
        if (campaignId !== undefined)
        {
            opts.onCampaign?.(campaignId);
        }

        // Runs already stored for this target are part of the union, so the
        // campaign's own contribution is only measurable against them. A
        // baseline the judge cannot produce is forfeited, not fatal — the
        // first round's consolidation supersedes it, and no review credit has
        // moved yet.
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
            recorder.baseline(latest.id);
            opts.onBaseline?.(latest.id, coverageOf(verifiableClusters(latest.clusters)));
        }

        // The rotation resumes from the target's stored evidence, so a
        // follow-up campaign spends its rounds where earlier ones did not look.
        const rotation: RotationSample[] = submittedRunsFor(store, target)
            .map(run => ({ ...(run.lens !== undefined ? { lens: run.lens } : {}), model: run.model }));

        for (let round = 1; round <= opts.maxRuns; round++)
        {
            if (opts.shouldStop?.() === true)
            {
                stoppedBy = 'stopped';
                break;
            }

            // The round's slice of the rotation: least-sampled lens (unless
            // switched off) and, when a roster was given, model. The pick
            // joins the tally whether or not the round turns out usable, so
            // an unusable round still consumes its slot — determinism over
            // backfilling.
            const pick = nextRound(rotation, {
                rotateLenses: opts.rotateLenses ?? true,
                ...(opts.models !== undefined ? { models: opts.models } : {}),
            });
            rotation.push({
                ...(pick.lens !== undefined ? { lens: pick.lens.name } : {}),
                ...(pick.model !== undefined ? { model: pick.model } : {}),
            });
            const lens = pick.lens;
            const model = pick.model ?? opts.model;
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
                    status: result.status,
                    ...(result.status === 'aborted' ? { reason: result.reason } : {}),
                    ...(result.status === 'submitted' ? { review: result.review } : {}),
                    turns: result.stats.turns,
                    costUsd: result.stats.costUsd,
                    usage: result.stats.usage,
                    filesChanged: result.filesChanged,
                });

                // An empty compare ends the campaign, not just the round: every
                // later round would compare the same base/head, so looping to
                // maxRuns would only store identical reviewed-nothing rows. It
                // never reaches shouldContinue — a merged or stale head says
                // nothing about saturation, and must not report as 'dry'.
                if (result.status === 'empty')
                {
                    record(outcome);
                    stoppedBy = 'empty-diff';
                    break;
                }

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
                record(outcome);
                consecutiveAborts++;
                if (consecutiveAborts >= ABORT_TOLERANCE)
                {
                    stoppedBy = 'no-usable-runs';
                    break;
                }
                continue;
            }
            consecutiveAborts = 0;

            // The judge is its own paid call, and its failure says nothing about
            // this round's review: the run is already saved, and the next round's
            // judge re-unions every stored run, so a transient judge abort self-
            // heals a round later. It must never kill the campaign — one did, on
            // 2026-08-19, after two paid rounds. The round simply carries no
            // consolidation, which also keeps it out of shouldContinue's input —
            // a judge outage neither counts barren nor resets patience. But
            // transient is a two-strike claim, same as ABORT_TOLERANCE: a judge
            // failing every round would otherwise burn the whole run cap on
            // reviews nothing can consolidate.
            try
            {
                const consolidation = await consolidateTarget(store, target, opts);
                consecutiveJudgeFailures = 0;
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
                consecutiveJudgeFailures++;
            }
            record(outcome);

            if (consecutiveJudgeFailures >= ABORT_TOLERANCE)
            {
                stoppedBy = 'no-consolidation';
                break;
            }
            if (!shouldContinue(rounds.filter(r => r.consolidationId !== undefined), opts.patience))
            {
                stoppedBy = 'dry';
                break;
            }
        }

        // The sampling loop is over and knows why — stoppedBy becomes
        // durable NOW, whichever transition follows, so a verification
        // failure can never lose it. When verification will run, the record
        // enters its 'verifying' phase instead of closing: the adversarial
        // passes bill for minutes, and liveness and the billing gates must
        // cover the whole paid span.
        if (opts.verify && latest !== undefined)
        {
            recorder.beginVerification(stoppedBy);
        }
        else
        {
            recorder.finish(stoppedBy);
        }
    }
    catch (error)
    {
        // Nothing inside the loop lets a throw escape — rounds catch their
        // own failures — so an escape is structural (a listener, or a bug),
        // and the row must not claim to be running forever.
        recorder.fail(error instanceof Error ? error.message : String(error));
        throw error;
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
        try
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
            recorder.complete(verification.stopped === true ? stoppedBy : undefined);
        }
        catch (error)
        {
            // Verification died with the loop's outcome already durable:
            // the record fails, stoppedBy survives on the failed row.
            recorder.fail(error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    return {
        ...(campaignId !== undefined ? { campaignId } : {}),
        rounds,
        ...(latest !== undefined ? { consolidationId: latest.id, runIds: latest.runIds } : { runIds: [] }),
        reviewCostUsd,
        judgeCostUsd,
        ...(verification !== undefined ? { verification } : {}),
        stoppedBy,
    };
}


// The campaign record's pen, holding the id, the liveness lease, and the
// observational-write rule in one place: every store call is wrapped, a
// failure warns through the campaign's own channel, and after a failed
// create the rest quietly no-op — there is no row to write to, and the loop
// was told once. The lease pairs with the record: held exactly while the
// row is live (running or verifying — both phases bill), released when
// finish/complete/fail closes it — and released by the kernel on any death,
// SIGKILL included, which is what lets a sweeper prove an abandoned row
// instead of guessing.
class CampaignRecorder
{
    private id: CampaignId | undefined;
    private lease: Lease | undefined;

    constructor(
        private readonly store: ReviewStore,
        private readonly warn: ((message: string) => void) | undefined,
    )
    {
    }

    // Throws DuplicateCampaignError — the one store answer that is policy,
    // not persistence, and must stop the loop rather than degrade it.
    create(target: Target): CampaignId | undefined
    {
        try
        {
            this.id = this.store.createCampaign(target);
        }
        catch (error)
        {
            if (error instanceof DuplicateCampaignError)
            {
                throw error;
            }
            this.emitWarning(`could not create the campaign record: ${error instanceof Error ? error.message : String(error)}`);
        }
        const id = this.id;
        if (id !== undefined)
        {
            try
            {
                this.lease = acquireCampaignLease(this.store.leaseDir, id);
                // Provability is claimed only AFTER the lease is held: rows
                // are born unproven, so a crash inside this very gap fails
                // safe (unsweepable) instead of sweepable-while-alive.
                if (this.lease !== undefined)
                {
                    this.guarded(`mark campaign #${id} leased`, () => this.store.markCampaignLeased(id));
                }
            }
            catch (error)
            {
                // A loop that cannot be leased still runs and bills; the row
                // simply never claims provability, and the sweep will refuse
                // to judge it — for THIS row an acquirable lease proves
                // nothing, and a false fail would also reopen the
                // duplicate-campaign billing gates mid-spend.
                this.emitWarning(`could not acquire the liveness lease for campaign #${id}: ${error instanceof Error ? error.message : String(error)} — liveness is unprovable for this record`);
            }
        }
        return this.id;
    }

    baseline(consolidation: ConsolidationId): void
    {
        const id = this.id;
        if (id !== undefined)
        {
            this.guarded(`record the baseline on campaign #${id}`, () => this.store.recordCampaignBaseline(id, consolidation));
        }
    }

    round(outcome: RoundOutcome): void
    {
        const id = this.id;
        if (id !== undefined)
        {
            this.guarded(`append round ${outcome.round} to campaign #${id}`, () => this.store.appendCampaignRound(id, outcome));
        }
    }

    // finish/complete/fail release the lease even when the closing write
    // itself failed (warned, row stuck live): a limbo row with no holder is
    // exactly what the sweep exists to give a terminal state.
    finish(stoppedBy: StoppedBy): void
    {
        const id = this.id;
        if (id !== undefined)
        {
            this.guarded(`finish campaign #${id}`, () => this.store.finishCampaign(id, stoppedBy));
        }
        this.releaseLease();
    }

    // The loop's tail: stoppedBy becomes durable now, before verification
    // spends anything, and the lease is deliberately KEPT — the adversarial
    // passes are the longest-billing span of a campaign, and liveness and
    // billing gates must cover it (campaign #1 found its own record reading
    // 'finished' while it verified).
    beginVerification(stoppedBy: StoppedBy): void
    {
        const id = this.id;
        if (id !== undefined)
        {
            this.guarded(`begin verification on campaign #${id}`, () => this.store.beginCampaignVerification(id, stoppedBy));
        }
    }

    // stoppedBy only when verification changed the loop's answer (a shutdown
    // cut the pass short); otherwise the reason beginVerification stored stands.
    complete(stoppedBy?: StoppedBy): void
    {
        const id = this.id;
        if (id !== undefined)
        {
            this.guarded(`finish verification on campaign #${id}`, () => this.store.finishVerifiedCampaign(id, stoppedBy));
        }
        this.releaseLease();
    }

    fail(error: string): void
    {
        const id = this.id;
        if (id !== undefined)
        {
            this.guarded(`fail campaign #${id}`, () => this.store.failCampaign(id, error));
        }
        this.releaseLease();
    }

    private releaseLease(): void
    {
        this.lease?.release();
        this.lease = undefined;
    }

    private guarded<T>(action: string, write: () => T): T | undefined
    {
        try
        {
            return write();
        }
        catch (error)
        {
            const message = error instanceof Error ? error.message : String(error);
            // Latch when the row has left our hands — deleted, or
            // transitioned by an external sweep. Decided by asking the store
            // for the row's state, never by parsing the error's wording (a
            // reworded message must not silently disable the latch, and a
            // deleted row latches the same as a failed one). Every later
            // write would fail identically, so say the actionable thing once
            // and go quiet, instead of one vague warning per paid round.
            const id = this.id;
            if (id !== undefined && !this.recordLive(id))
            {
                this.emitWarning(`campaign #${id}'s record is no longer writable (${message}) — its remaining history will not be persisted`);
                this.id = undefined;
                this.releaseLease();
                return undefined;
            }
            this.emitWarning(`could not ${action}: ${message}`);
            return undefined;
        }
    }

    private recordLive(id: CampaignId): boolean
    {
        try
        {
            const status = this.store.getCampaign(id)?.status;
            return status === 'running' || status === 'verifying';
        }
        catch
        {
            // Unknown is not proof — a read failure must not latch away the
            // rest of a campaign's history.
            return true;
        }
    }

    // The warning channel is observational squared: a listener that throws
    // must not become the thing that kills a billing loop.
    private emitWarning(message: string): void
    {
        try
        {
            this.warn?.(message);
        }
        catch
        {
            // Nowhere left to report to.
        }
    }
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
