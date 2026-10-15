import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignOptions, CampaignResult } from '../../src/campaign/campaign.js';
import type { ChangedFile, RepoClient } from '../../src/github/github.js';
import type { ReviewResult, ReviewRunStats } from '../../src/review/review.js';
import { ReviewStore } from '../../src/store/store.js';
import { JobStore } from '../../src/server/jobs.js';
import type { NewJob } from '../../src/server/jobs.js';
import { Worker } from '../../src/server/worker.js';
import type { WorkerDeps } from '../../src/server/worker.js';
import { campaignId, consolidationId, runId } from '../../src/types/ids.js';

class FakeRepoClient implements RepoClient
{
    async compare(): Promise<ChangedFile[]>
    {
        return [];
    }

    async readFile(): Promise<string>
    {
        return '';
    }

    async listFiles(): Promise<{ paths: string[]; truncated: boolean }>
    {
        return { paths: [], truncated: false };
    }
}

function stats(): ReviewRunStats
{
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    return { turns: 30, costUsd: 2.5, usage, perModel: {}, turnUsage: [], compactions: 0 };
}

function submitted(): ReviewResult
{
    return { status: 'submitted', review: { summary: 'clean', findings: [] }, filesChanged: 3, stats: stats() };
}

function reviewJob(overrides: Partial<NewJob> = {}): NewJob
{
    return {
        kind: 'review',
        owner: 'acme',
        repo: 'widgets',
        head: 'feature/x',
        base: 'main',
        params: {},
        ...overrides,
    } as NewJob;
}

let jobs: JobStore;
let store: ReviewStore;

beforeEach(() =>
{
    jobs = new JobStore(':memory:');
    store = new ReviewStore(':memory:');
});

afterEach(() =>
{
    jobs.close();
    store.close();
});

function worker(overrides: Partial<WorkerDeps> = {}): Worker
{
    return new Worker({
        jobs,
        store,
        clientFor: () => new FakeRepoClient(),
        defaultModel: 'claude-opus-5',
        defaultVerifyModel: 'verify-model-default',
        review: async () => submitted(),
        campaign: async () => ({ rounds: [], runIds: [], reviewCostUsd: 0, judgeCostUsd: 0, stoppedBy: 'max-runs' }),
        ...overrides,
    });
}

describe('review jobs', () =>
{
    it('should succeed a submitted review and record the saved run', async () =>
    {
        // Arrange
        const id = jobs.enqueue(reviewJob());

        // Act
        const processed = await worker().notify();

        // Assert
        expect(processed).toBe(1);
        const job = jobs.get(id);
        expect(job?.state).toBe('succeeded');
        expect(job?.runIds).toHaveLength(1);
        const run = store.getRun(job!.runIds[0]!);
        expect(run).toMatchObject({ owner: 'acme', repo: 'widgets', head: 'feature/x', status: 'submitted' });
    });

    it('should apply the default model when params omit one', async () =>
    {
        // Arrange
        const id = jobs.enqueue(reviewJob());

        // Act
        await worker().notify();

        // Assert
        expect(store.getRun(jobs.get(id)!.runIds[0]!)?.model).toBe('claude-opus-5');
    });

    it('should let the job params override the model', async () =>
    {
        // Arrange
        let requested: string | undefined;
        const id = jobs.enqueue(reviewJob({ params: { model: 'claude-sonnet-5' } }));

        // Act
        await worker({
            review: async (_client, _target, opts) =>
            {
                requested = opts?.model;
                return submitted();
            },
        }).notify();

        // Assert
        expect(requested).toBe('claude-sonnet-5');
        expect(store.getRun(jobs.get(id)!.runIds[0]!)?.model).toBe('claude-sonnet-5');
    });

    it('should abort the job on a capped run and keep the aborted run', async () =>
    {
        // Arrange
        const id = jobs.enqueue(reviewJob());

        // Act
        await worker({
            review: async () => ({ status: 'aborted', reason: 'error_max_turns', filesChanged: 3, stats: stats() }),
        }).notify();

        // Assert
        const job = jobs.get(id);
        expect(job).toMatchObject({ state: 'aborted', error: 'error_max_turns' });
        expect(store.getRun(job!.runIds[0]!)?.status).toBe('aborted');
    });

    it('should fail the job when the review throws, and keep draining', async () =>
    {
        // Arrange
        const bad = jobs.enqueue(reviewJob());
        const good = jobs.enqueue(reviewJob({ head: 'feature/y' }));
        let calls = 0;

        // Act
        const processed = await worker({
            review: async () =>
            {
                if (++calls === 1)
                {
                    throw new Error('GitHub compare returned 502');
                }
                return submitted();
            },
        }).notify();

        // Assert
        expect(processed).toBe(2);
        expect(jobs.get(bad)).toMatchObject({ state: 'failed', error: 'GitHub compare returned 502' });
        expect(jobs.get(good)?.state).toBe('succeeded');
    });

    it('should fail the job when the run cannot be saved: the result is only reachable through the store', async () =>
    {
        // Arrange
        class UnsavableStore extends ReviewStore
        {
            override saveRun(): never
            {
                throw new Error('disk full');
            }
        }
        const unsavable = new UnsavableStore(':memory:');
        const id = jobs.enqueue(reviewJob());

        // Act
        await worker({ store: unsavable }).notify();

        // Assert
        expect(jobs.get(id)).toMatchObject({ state: 'failed', error: 'disk full' });
        unsavable.close();
    });
});

describe('campaign jobs', () =>
{
    function campaignJob(overrides: Partial<NewJob> = {}): NewJob
    {
        return {
            kind: 'campaign',
            owner: 'acme',
            repo: 'widgets',
            head: 'feature/x',
            base: 'main',
            params: { maxRuns: 3, verify: true },
            ...overrides,
        } as NewJob;
    }

    it('should record runs round by round and succeed with the consolidation', async () =>
    {
        // Arrange
        const id = jobs.enqueue(campaignJob());
        const result: CampaignResult = {
            rounds: [],
            consolidationId: consolidationId(9),
            runIds: [runId(1), runId(2)],
            reviewCostUsd: 5,
            judgeCostUsd: 0.4,
            stoppedBy: 'dry',
        };

        // Act
        await worker({
            campaign: async (_store, _client, _target, opts) =>
            {
                opts.onRun?.({ round: 1, runId: runId(1), findings: 4, turns: 30, costUsd: 2.5, novelClusters: 4 });
                opts.onRun?.({ round: 2, findings: 0, turns: 0, costUsd: 0, failed: 'GitHub API 502', novelClusters: 0 });
                opts.onRun?.({ round: 3, runId: runId(2), findings: 3, turns: 28, costUsd: 2.5, novelClusters: 0 });
                return result;
            },
        }).notify();

        // Assert: the failed round has no run to record, the others land in order.
        expect(jobs.get(id)).toMatchObject({ state: 'succeeded', runIds: [1, 2], consolidationId: 9 });
    });

    it('should pass the campaign params through', async () =>
    {
        // Arrange
        let received: CampaignOptions | undefined;
        jobs.enqueue(campaignJob({ params: {
            maxRuns: 5, patience: 2, verify: false, maxTurns: 24,
            models: ['model-a', 'model-b'], rotateLenses: false,
        } }));

        // Act
        await worker({
            campaign: async (_store, _client, _target, opts) =>
            {
                received = opts;
                return { rounds: [], runIds: [], reviewCostUsd: 0, judgeCostUsd: 0, stoppedBy: 'max-runs' };
            },
        }).notify();

        // Assert: the rotation knobs ride along; `model` still resolves so
        // the verify fallback has an anchor even when a roster is given.
        expect(received).toMatchObject({
            maxRuns: 5, patience: 2, verify: false, maxTurns: 24, model: 'claude-opus-5',
            models: ['model-a', 'model-b'], rotateLenses: false,
        });
    });

    it('should link the campaign record the loop opens, as provenance on the job', async () =>
    {
        // Arrange
        const id = jobs.enqueue(campaignJob());

        // Act
        await worker({
            campaign: async (_store, _client, _target, opts) =>
            {
                opts.onCampaign?.(campaignId(7));
                return { rounds: [], runIds: [], reviewCostUsd: 0, judgeCostUsd: 0, stoppedBy: 'max-runs' };
            },
        }).notify();

        // Assert
        expect(jobs.get(id)?.campaignId).toBe(7);
    });

    it('should abort when the campaign stops with no usable runs', async () =>
    {
        // Arrange
        const id = jobs.enqueue(campaignJob());

        // Act
        await worker({
            campaign: async () => ({ rounds: [], runIds: [], reviewCostUsd: 0, judgeCostUsd: 0, stoppedBy: 'no-usable-runs' }),
        }).notify();

        // Assert
        expect(jobs.get(id)).toMatchObject({
            state: 'aborted',
            error: 'no-usable-runs: two consecutive rounds aborted or failed',
        });
    });

    it('should fail the job when the campaign throws', async () =>
    {
        // Arrange
        const id = jobs.enqueue(campaignJob());

        // Act
        await worker({
            campaign: async () =>
            {
                throw new Error('consolidation judge returned an invalid partition');
            },
        }).notify();

        // Assert
        expect(jobs.get(id)).toMatchObject({
            state: 'failed',
            error: 'consolidation judge returned an invalid partition',
        });
    });
});

describe('notify', () =>
{
    it('should drain jobs enqueued while a drain is running', async () =>
    {
        // Arrange: the first job enqueues a second mid-execution.
        jobs.enqueue(reviewJob());
        let calls = 0;

        // Act
        const processed = await worker({
            review: async () =>
            {
                if (++calls === 1)
                {
                    jobs.enqueue(reviewJob({ head: 'feature/y' }));
                }
                return submitted();
            },
        }).notify();

        // Assert
        expect(processed).toBe(2);
        expect(jobs.list().every(j => j.state === 'succeeded')).toBe(true);
    });

    it('should reject when a job escapes running mid-execution, and keep the queue alive for the next kick', async () =>
    {
        // Arrange: the runner sabotages the job's state before throwing, so
        // the error is the worker's own (not the job's) and must propagate
        // out of notify() rather than fail the job.
        const first = jobs.enqueue(reviewJob());
        let calls = 0;
        const w = worker({
            review: async () =>
            {
                if (++calls === 1)
                {
                    jobs.fail(jobs.list().find(j => j.state === 'running')!.id, 'sabotaged');
                    throw new Error('boom');
                }
                return submitted();
            },
        });

        // Act
        await expect(w.notify()).rejects.toThrow('boom');
        const second = jobs.enqueue(reviewJob({ head: 'feature/y' }));
        const processed = await w.notify();

        // Assert: the rejection reached the first kick's caller only — the
        // next kick drains normally instead of inheriting a poisoned chain.
        expect(processed).toBe(1);
        expect(jobs.get(first)?.state).toBe('failed');
        expect(jobs.get(second)?.state).toBe('succeeded');
    });

    it('should stop claiming after stop(), letting the in-flight job record its outcome', async () =>
    {
        // Arrange: two queued jobs; the first blocks until released, and
        // stop() lands while it is mid-flight.
        const first = jobs.enqueue(reviewJob());
        const second = jobs.enqueue(reviewJob({ head: 'feature/y' }));
        let release!: () => void;
        const gate = new Promise<void>(resolve =>
        {
            release = resolve;
        });
        let started!: () => void;
        const firstStarted = new Promise<void>(resolve =>
        {
            started = resolve;
        });
        const w = worker({
            review: async () =>
            {
                started();
                await gate;
                return submitted();
            },
        });

        // Act
        const pass = w.notify();
        await firstStarted;
        const stopped = w.stop();
        release();
        await stopped;

        // Assert: the paid job finished and recorded; the unstarted one
        // spent nothing and stays queued, owed a run at the next start.
        expect(await pass).toBe(1);
        expect(jobs.get(first)?.state).toBe('succeeded');
        expect(jobs.get(second)?.state).toBe('queued');
    });

    it('should reach into a running campaign: stop() must end the plan, not just the claim loop', async () =>
    {
        // Arrange: a campaign job whose runner behaves like the real one —
        // it polls shouldStop and reports how the plan ended.
        const id = jobs.enqueue({
            kind: 'campaign', owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main',
            params: { maxRuns: 5, verify: true },
        } as NewJob);
        let inRound!: () => void;
        const roundStarted = new Promise<void>(resolve =>
        {
            inRound = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>(resolve =>
        {
            release = resolve;
        });
        const w = worker({
            campaign: async (_store, _client, _target, opts): Promise<CampaignResult> =>
            {
                inRound();
                await gate;
                return {
                    rounds: [], runIds: [], consolidationId: consolidationId(9),
                    reviewCostUsd: 0, judgeCostUsd: 0,
                    stoppedBy: opts.shouldStop?.() === true ? 'stopped' : 'max-runs',
                };
            },
        });

        // Act: stop lands mid-campaign, then the round in flight finishes.
        const pass = w.notify();
        await roundStarted;
        const stopped = w.stop();
        release();
        await stopped;
        await pass;

        // Assert: the campaign saw the signal and the cut-short plan is an
        // abort with the reason stored, never a clean success — and the
        // consolidation the completed rounds bought stays on the job.
        expect(jobs.get(id)).toMatchObject({ state: 'aborted', consolidationId: 9 });
        expect(jobs.get(id)?.error).toContain('stopped: shutdown interrupted the campaign');
    });

    it('should resolve stop() immediately on an idle worker', async () =>
    {
        // Act & Assert
        await expect(worker().stop()).resolves.toBeUndefined();
    });

    it('should report progress events against the job id', async () =>
    {
        // Arrange
        const id = jobs.enqueue(reviewJob());
        const events: string[] = [];

        // Act
        await worker({
            review: async (_client, _target, opts) =>
            {
                opts?.onProgress?.('list_changed_files({})');
                return submitted();
            },
            onEvent: (jobId, event) => events.push(`#${jobId} ${event}`),
        }).notify();

        // Assert
        expect(events).toEqual([`#${id} list_changed_files({})`]);
    });
});

describe('verify jobs', () =>
{
    const finding = { file: 'a.ts', severity: 'nit' as const, title: 'loose end', detail: 'evidence' };

    function submittedWithFindings(): ReviewResult
    {
        return { status: 'submitted', review: { summary: 'one nit', findings: [finding] }, filesChanged: 2, stats: stats() };
    }

    it('should auto-enqueue a held verify job after a review with findings', async () =>
    {
        // Arrange
        const id = jobs.enqueue(reviewJob());

        // Act
        await worker({ review: async () => submittedWithFindings() }).notify();

        // Assert: the review succeeded, and the adversarial pass is proposed
        // — held, so no further credit moves without a human release.
        expect(jobs.get(id)?.state).toBe('succeeded');
        const verify = jobs.list().find(j => j.kind === 'verify');
        expect(verify).toMatchObject({ state: 'held', owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main' });
    });

    it('should keep the review succeeded when proposing the verify job fails', async () =>
    {
        // Arrange: the review's own writes work; the follow-up proposal hits
        // a broken store. Persistence never changes an outcome — a run that
        // ran, billed, and saved must stay succeeded.
        const id = jobs.enqueue(reviewJob());
        const events: string[] = [];
        jobs.enqueue = () =>
        {
            throw new Error('disk full');
        };

        // Act
        await worker({
            review: async () => submittedWithFindings(),
            onEvent: (jobId, event) => events.push(`#${jobId}: ${event}`),
        }).notify();

        // Assert
        expect(jobs.get(id)?.state).toBe('succeeded');
        expect(events).toContain(`#${id}: could not propose a verify job: disk full`);
    });

    it('should cost one drain, not the queue, when a listener throws after succeed()', async () =>
    {
        // Arrange: an onEvent that always throws. After succeed() the job has
        // left `running`, so the throw escapes execute() and rejects the drain.
        let review = submittedWithFindings();
        const resilient = worker({
            review: async () => review,
            onEvent: () =>
            {
                throw new Error('listener bug');
            },
        });
        const first = jobs.enqueue(reviewJob());

        // Act + Assert: the rejection reaches this drain's caller (serve's
        // crash log), but the job itself stayed succeeded.
        await expect(resilient.notify()).rejects.toThrow('listener bug');
        expect(jobs.get(first)?.state).toBe('succeeded');

        // The chain healed: the next notify drains the next job instead of
        // short-circuiting on the dead tail forever.
        review = submitted();
        const second = jobs.enqueue(reviewJob({ head: 'feature/y' }));
        await expect(resilient.notify()).resolves.toBe(1);
        expect(jobs.get(second)?.state).toBe('succeeded');
    });

    it('should not propose verification when the review found nothing', async () =>
    {
        // Arrange: the default submitted() carries zero findings.
        jobs.enqueue(reviewJob());

        // Act
        await worker().notify();

        // Assert
        expect(jobs.list().some(j => j.kind === 'verify')).toBe(false);
    });

    it('should keep a saved review succeeded even when proposing the verify job fails', async () =>
    {
        // Arrange: the proposal is a convenience on top of a finished job —
        // its failure must not breach "persistence never changes an outcome".
        class UnproposableJobs extends JobStore
        {
            override enqueue(job: NewJob, opts?: { held?: boolean }): ReturnType<JobStore['enqueue']>
            {
                if (job.kind === 'verify')
                {
                    throw new Error('jobs table locked');
                }
                return super.enqueue(job, opts);
            }
        }
        const fragile = new UnproposableJobs(':memory:');
        const id = fragile.enqueue(reviewJob());
        const events: string[] = [];

        // Act
        await worker({
            jobs: fragile,
            review: async () => submittedWithFindings(),
            onEvent: (_id, event) => events.push(event),
        }).notify();

        // Assert
        expect(fragile.get(id)?.state).toBe('succeeded');
        expect(events.some(e => e.includes('could not propose a verify job'))).toBe(true);
        fragile.close();
    });

    it('should succeed an empty-diff review with an empty run and no verify proposal', async () =>
    {
        // Arrange
        const id = jobs.enqueue(reviewJob());

        // Act
        await worker({
            review: async () => ({ status: 'empty', filesChanged: 0, stats: stats() }),
        }).notify();

        // Assert: a completed job over a run that reviewed nothing — stored
        // as 'empty', so nothing downstream can read it as a clean review.
        const job = jobs.get(id);
        expect(job?.state).toBe('succeeded');
        const run = store.getRun(job!.runIds[0]!);
        expect(run?.status).toBe('empty');
        expect(run?.review).toBeUndefined();
        expect(jobs.list().some(j => j.kind === 'verify')).toBe(false);
    });

    it('should not stack a second verify job while one is already open', async () =>
    {
        // Arrange
        jobs.enqueue({ kind: 'verify', owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main', params: {} }, { held: true });
        jobs.enqueue(reviewJob());

        // Act
        await worker({ review: async () => submittedWithFindings() }).notify();

        // Assert
        expect(jobs.list().filter(j => j.kind === 'verify')).toHaveLength(1);
    });

    it('should execute a released verify job and store the consolidation id', async () =>
    {
        // Arrange
        const cid = consolidationId(7);
        const id = jobs.enqueue({ kind: 'verify', owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main', params: {} }, { held: true });
        jobs.release(id);

        // Act
        await worker({
            verify: async () => ({ consolidationId: cid, reused: false, summary: { queued: 2, attempted: 2, verified: 2, failures: 0, costUsd: 1.2 } }),
        }).notify();

        // Assert
        expect(jobs.get(id)).toMatchObject({ state: 'succeeded', consolidationId: cid });
    });

    it('should default a verify job to the verify-role model, not the reviewer default', async () =>
    {
        // Arrange: params omit the model — the common case, and the one that
        // silently ignored VERIFY_MODEL on the server path (smoke rev 14).
        jobs.enqueue({ kind: 'verify', owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main', params: {} });
        let received: string | undefined;

        // Act
        await worker({
            verify: async (_store, _client, _target, opts) =>
            {
                received = opts?.model;
                return { reused: false, summary: { queued: 0, attempted: 0, verified: 0, failures: 0, costUsd: 0 } };
            },
        }).notify();

        // Assert
        expect(received).toBe('verify-model-default');
    });

    it('should hand the campaign the verify-role model so its closing pass honors VERIFY_MODEL', async () =>
    {
        // Arrange
        jobs.enqueue({
            kind: 'campaign', owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main',
            params: { maxRuns: 1, verify: true },
        } as NewJob);
        let received: CampaignOptions | undefined;

        // Act
        await worker({
            campaign: async (_store, _client, _target, opts): Promise<CampaignResult> =>
            {
                received = opts;
                return { rounds: [], runIds: [], reviewCostUsd: 0, judgeCostUsd: 0, stoppedBy: 'max-runs' };
            },
        }).notify();

        // Assert
        expect(received?.verifyModel).toBe('verify-model-default');
    });

    it('should hand a verify job the worker\'s stop signal and abort it when the pass was cut short', async () =>
    {
        // Arrange: the runner behaves like the real verifyTarget under a
        // shutdown — it consults shouldStop and reports a cut-short summary.
        const cid = consolidationId(11);
        const id = jobs.enqueue({ kind: 'verify', owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main', params: {} });
        let sawStopSignal: boolean | undefined;

        // Act
        await worker({
            verify: async (_store, _client, _target, opts) =>
            {
                sawStopSignal = typeof opts?.shouldStop === 'function';
                return { consolidationId: cid, reused: false, summary: { queued: 3, attempted: 1, verified: 1, failures: 0, costUsd: 0.5, stopped: true } };
            },
        }).notify();

        // Assert: verdicts already recorded are saved, the consolidation the
        // pass ran on stays reachable from the job, and the job must not
        // read as a completed verification plan.
        expect(sawStopSignal).toBe(true);
        expect(jobs.get(id)).toMatchObject({
            state: 'aborted',
            consolidationId: cid,
            error: expect.stringContaining('shutdown interrupted verification') as string,
        });
    });

    it('should surface the campaign\'s verification phase in the job feed', async () =>
    {
        // Arrange: the closing verification is its own string of paid calls —
        // without wired reporting the feed goes silent for the whole phase.
        const id = jobs.enqueue({
            kind: 'campaign', owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main',
            params: { maxRuns: 1, verify: true },
        } as NewJob);
        const events: string[] = [];
        const clusterStub = {
            id: 7,
            representative: { title: 'loose end' },
        } as unknown as Parameters<NonNullable<NonNullable<CampaignOptions['verifyReporting']>['onCluster']>>[0];

        // Act
        await worker({
            campaign: async (_store, _client, _target, opts): Promise<CampaignResult> =>
            {
                opts.verifyReporting?.onCluster?.(clusterStub);
                opts.verifyReporting?.onVerdict?.(clusterStub,
                    { verdict: 'confirmed', rationale: 'because', confidence: 'sure' },
                    { turns: 3, costUsd: 0.5, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
                opts.verifyReporting?.onFailure?.(clusterStub, 'GitHub 502');
                return { rounds: [], runIds: [], reviewCostUsd: 0, judgeCostUsd: 0, stoppedBy: 'max-runs' };
            },
            onEvent: (jobId, event) => events.push(`#${jobId} ${event}`),
        }).notify();

        // Assert
        expect(events).toEqual([
            `#${id} verifying cluster #7: loose end`,
            `#${id} cluster #7: confirmed ($0.50)`,
            `#${id} cluster #7 failed: GitHub 502`,
        ]);
    });

    it('should fail a verify job whose target has no submitted runs', async () =>
    {
        // Arrange
        const id = jobs.enqueue({ kind: 'verify', owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main', params: {} });

        // Act
        await worker({
            verify: async () => 
            {
                throw new Error('No submitted runs for this target — nothing to verify.'); 
            },
        }).notify();

        // Assert
        expect(jobs.get(id)).toMatchObject({
            state: 'failed',
            error: expect.stringContaining('No submitted runs') as string,
        });
    });
});
