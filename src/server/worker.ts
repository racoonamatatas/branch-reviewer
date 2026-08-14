// The worker: turns queued jobs into finished ones, one at a time. Sequential
// on purpose — subscription credit is a serial resource, and back-to-back
// runs of one target ride each other's prompt cache, so parallelism would
// cost more, not less. Outcomes map onto the locked error taxonomy: a
// submitted review succeeds, a capped run (maxTurns) aborts, and a throw —
// network, GitHub, auth — fails the job with the error preserved. Retrying
// transient failures is a policy decision deferred to the caller re-enqueuing;
// the worker itself never re-runs anything, because a re-run bills real
// credit.

import { runCampaign } from '../campaign/campaign.js';
import type { RepoClient } from '../github/github.js';
import { runReview } from '../review/review.js';
import type { ReviewStore } from '../store/store.js';
import type { JobId } from '../types/ids.js';
import { verifyTarget } from '../verify/verify.js';
import type { CampaignJob, Job, JobStore, ReviewJob, VerifyJob } from './jobs.js';

export interface WorkerDeps
{
    jobs: JobStore;
    store: ReviewStore;
    clientFor: (owner: string, repo: string) => RepoClient;
    // Applied when a job's params carry no model — resolution happens here so
    // the stored job keeps what the requester actually asked for.
    defaultModel: string;
    onEvent?: (id: JobId, event: string) => void;
    // The stage runners, injectable so the state machine is testable without
    // burning credit. Production callers omit them.
    review?: typeof runReview;
    campaign?: typeof runCampaign;
    verify?: typeof verifyTarget;
}

export class Worker
{
    private readonly jobs: JobStore;
    private readonly store: ReviewStore;
    private readonly clientFor: (owner: string, repo: string) => RepoClient;
    private readonly defaultModel: string;
    private readonly onEvent: ((id: JobId, event: string) => void) | undefined;
    private readonly review: typeof runReview;
    private readonly campaign: typeof runCampaign;
    private readonly verify: typeof verifyTarget;
    private tail: Promise<number> = Promise.resolve(0);
    private stopping = false;

    constructor(deps: WorkerDeps)
    {
        this.jobs = deps.jobs;
        this.store = deps.store;
        this.clientFor = deps.clientFor;
        this.defaultModel = deps.defaultModel;
        this.onEvent = deps.onEvent;
        this.review = deps.review ?? runReview;
        this.campaign = deps.campaign ?? runCampaign;
        this.verify = deps.verify ?? verifyTarget;
    }

    // Kick the worker: drains the queue until empty, one job at a time.
    // Drains chain rather than overlap, so a job enqueued in the race window
    // between the final empty claimNext and the drain resolving is still
    // picked up by the chained pass instead of stranded until the next kick.
    // Resolves with the number of jobs this drain processed.
    // The stored tail is the settled copy, not the pass itself: a drain can
    // reject (execute rethrows when a job escapes `running`), and chaining
    // future drains off a rejected promise would stop the worker for the
    // life of the process while the server keeps logging "worker crashed".
    // The caller of this notify still sees the rejection.
    notify(): Promise<number>
    {
        const pass = this.tail.then(() => this.drain());
        this.tail = pass.catch(() => 0);
        return pass;
    }

    // Graceful shutdown: stop claiming, let the in-flight job finish. Its
    // credit is committed the moment query() starts — abandoning it is the
    // "credit spent, result lost" bug this exists to delete — while a job
    // still queued has spent nothing and is owed a run at the next start.
    // Resolves when the in-flight job (if any) has recorded its outcome.
    stop(): Promise<void>
    {
        this.stopping = true;
        return this.tail.then(() => undefined);
    }

    private async drain(): Promise<number>
    {
        let processed = 0;
        while (!this.stopping)
        {
            const job = this.jobs.claimNext();
            if (job === undefined)
            {
                break;
            }
            await this.execute(job);
            processed++;
        }
        return processed;
    }

    // A throw anywhere in a job — the runner, GitHub, a failed save — fails
    // that job and the drain moves on: one bad job must not strand the queue.
    // If the job somehow already left `running`, the error is ours, not the
    // job's, and it propagates.
    private async execute(job: Job): Promise<void>
    {
        try
        {
            switch (job.kind)
            {
                case 'review':
                    await this.executeReview(job);
                    break;
                case 'campaign':
                    await this.executeCampaign(job);
                    break;
                case 'verify':
                    await this.executeVerify(job);
                    break;
            }
        }
        catch (error)
        {
            const message = error instanceof Error ? error.message : String(error);
            if (this.jobs.get(job.id)?.state !== 'running')
            {
                throw error;
            }
            this.jobs.fail(job.id, message);
            this.onEvent?.(job.id, `failed: ${message}`);
        }
    }

    private async executeReview(job: ReviewJob): Promise<void>
    {
        const model = job.params.model ?? this.defaultModel;
        const result = await this.review(this.clientFor(job.owner, job.repo), { base: job.base, head: job.head }, {
            model,
            ...(job.params.maxTurns !== undefined ? { maxTurns: job.params.maxTurns } : {}),
            ...(job.params.context !== undefined ? { context: job.params.context } : {}),
            onProgress: event => this.onEvent?.(job.id, event),
        });

        // Unlike the CLI — where the reviewer prints the result and a failed
        // save only warns — a job's result is reachable only through the
        // store, so a run that cannot be saved leaves nothing to succeed
        // with: the save failure fails the job (via the catch above), with
        // the credit already spent either way.
        const run = this.store.saveRun({
            owner: job.owner,
            repo: job.repo,
            head: job.head,
            base: job.base,
            model,
            status: result.status,
            ...(result.status === 'aborted' ? { reason: result.reason } : { review: result.review }),
            turns: result.stats.turns,
            costUsd: result.stats.costUsd,
            usage: result.stats.usage,
            filesChanged: result.filesChanged,
        });
        this.jobs.recordRun(job.id, run);

        if (result.status === 'aborted')
        {
            this.jobs.abort(job.id, result.reason);
            return;
        }

        // The review ran, billed, and saved — it has succeeded, and nothing
        // after this line may change that. The verify proposal below is a
        // convenience on top of a finished job, so its failure only reports.
        this.jobs.succeed(job.id);

        // Findings are claims until verified, and this run may be the only
        // one this target ever gets — propose the adversarial pass as a held
        // job (a human release bills it). Skipped when one is already open,
        // and when there is nothing to verify.
        try
        {
            if (result.review.findings.length > 0
                && !this.jobs.hasOpenJobFor(job.owner, job.repo, job.head, 'verify'))
            {
                const verifyId = this.jobs.enqueue({
                    kind: 'verify',
                    owner: job.owner,
                    repo: job.repo,
                    head: job.head,
                    base: job.base,
                    params: {},
                }, { held: true });
                this.onEvent?.(job.id, `${result.review.findings.length} finding(s) are unverified claims — verify job #${verifyId} enqueued held, release to run`);
            }
        }
        catch (error)
        {
            this.onEvent?.(job.id, `could not propose a verify job: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async executeCampaign(job: CampaignJob): Promise<void>
    {
        const result = await this.campaign(
            this.store,
            this.clientFor(job.owner, job.repo),
            { owner: job.owner, repo: job.repo, head: job.head, base: job.base },
            {
                maxRuns: job.params.maxRuns,
                verify: job.params.verify,
                model: job.params.model ?? this.defaultModel,
                ...(job.params.models !== undefined ? { models: job.params.models } : {}),
                ...(job.params.rotateLenses !== undefined ? { rotateLenses: job.params.rotateLenses } : {}),
                ...(job.params.maxTurns !== undefined ? { maxTurns: job.params.maxTurns } : {}),
                ...(job.params.patience !== undefined ? { patience: job.params.patience } : {}),
                ...(job.params.reverify !== undefined ? { reverify: job.params.reverify } : {}),
                // Rounds land on the job as they finish — a campaign's
                // progress is visible mid-flight, which is the point of a
                // job model. A failed round has no run to record.
                onRun: (outcome) =>
                {
                    if (outcome.runId !== undefined)
                    {
                        this.jobs.recordRun(job.id, outcome.runId);
                    }
                    // An unusable round otherwise vanishes: the campaign
                    // abort only says "no-usable-runs", and whoever is
                    // watching the feed deserves the actual error (found
                    // live: two instant 404s read as a silent 0.8s abort).
                    if (outcome.failed !== undefined)
                    {
                        this.onEvent?.(job.id, `round ${outcome.round} failed: ${outcome.failed}`);
                    }
                    else if (outcome.aborted !== undefined)
                    {
                        this.onEvent?.(job.id, `round ${outcome.round} aborted: ${outcome.aborted}`);
                    }
                    // Same silence, judge-shaped: the run is saved and the
                    // round moves on, but a campaign whose every judge call
                    // dies otherwise ends "succeeded" with no consolidation
                    // and no trace (lived experience, not hypothesis).
                    if (outcome.consolidationFailed !== undefined)
                    {
                        this.onEvent?.(job.id, `round ${outcome.round} consolidation failed: ${outcome.consolidationFailed}`);
                    }
                },
                onRoundStart: (round, of, lens) =>
                    this.onEvent?.(job.id, `round ${round}/${of}${lens !== undefined ? ` (${lens} lens)` : ''}`),
                onJudgeDegraded: violation => this.onEvent?.(job.id, `clustering degraded: ${violation}`),
            },
        );

        // Two consecutive unusable rounds is the campaign's own abort path —
        // structural, mirroring a single review's cap — while running dry or
        // out of runs are both successful completions of the sampling plan.
        if (result.stoppedBy === 'no-usable-runs')
        {
            this.jobs.abort(job.id, 'no-usable-runs: two consecutive rounds aborted or failed');
            return;
        }
        this.jobs.succeed(job.id, {
            ...(result.consolidationId !== undefined ? { consolidationId: result.consolidationId } : {}),
        });
    }

    // Consolidate-if-needed + adversarial pass, both inside verifyTarget; a
    // target with no submitted runs throws there and fails the job with the
    // named reason. A target whose runs had no findings succeeds vacuously —
    // "nothing to verify" is a completed verification plan, not an error.
    private async executeVerify(job: VerifyJob): Promise<void>
    {
        const result = await this.verify(
            this.store,
            this.clientFor(job.owner, job.repo),
            { owner: job.owner, repo: job.repo, head: job.head, base: job.base },
            {
                model: job.params.model ?? this.defaultModel,
                ...(job.params.maxTurns !== undefined ? { maxTurns: job.params.maxTurns } : {}),
                ...(job.params.reverify !== undefined ? { reverify: job.params.reverify } : {}),
                onEvent: event => this.onEvent?.(job.id, event),
            },
        );
        this.onEvent?.(job.id, `verified ${result.summary.verified}/${result.summary.attempted} cluster(s), `
            + `${result.summary.failures} failure(s), $${result.summary.costUsd.toFixed(2)}`);
        this.jobs.succeed(job.id, {
            ...(result.consolidationId !== undefined ? { consolidationId: result.consolidationId } : {}),
        });
    }
}
