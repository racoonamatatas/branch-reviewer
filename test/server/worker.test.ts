import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignOptions, CampaignResult } from '../../src/campaign/campaign.js';
import type { ChangedFile, RepoClient } from '../../src/github/github.js';
import type { ReviewResult, ReviewRunStats } from '../../src/review/review.js';
import { ReviewStore } from '../../src/store/store.js';
import { JobStore } from '../../src/server/jobs.js';
import type { NewJob } from '../../src/server/jobs.js';
import { Worker } from '../../src/server/worker.js';
import type { WorkerDeps } from '../../src/server/worker.js';
import { consolidationId, runId } from '../../src/types/ids.js';

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
}

function stats(): ReviewRunStats
{
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    return { turns: 30, costUsd: 2.5, usage, perModel: {}, streamed: usage, turnUsage: [], compactions: 0 };
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
        review: async () => submitted(),
        campaign: async () => ({ rounds: [], runIds: [], reviewCostUsd: 0, stoppedBy: 'max-runs' }),
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
        jobs.enqueue(campaignJob({ params: { maxRuns: 5, patience: 2, verify: false, maxTurns: 24 } }));

        // Act
        await worker({
            campaign: async (_store, _client, _target, opts) =>
            {
                received = opts;
                return { rounds: [], runIds: [], reviewCostUsd: 0, stoppedBy: 'max-runs' };
            },
        }).notify();

        // Assert
        expect(received).toMatchObject({ maxRuns: 5, patience: 2, verify: false, maxTurns: 24, model: 'claude-opus-5' });
    });

    it('should abort when the campaign stops with no usable runs', async () =>
    {
        // Arrange
        const id = jobs.enqueue(campaignJob());

        // Act
        await worker({
            campaign: async () => ({ rounds: [], runIds: [], reviewCostUsd: 0, stoppedBy: 'no-usable-runs' }),
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

    it('should not propose verification when the review found nothing', async () =>
    {
        // Arrange: the default submitted() carries zero findings.
        jobs.enqueue(reviewJob());

        // Act
        await worker().notify();

        // Assert
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
            verify: async () => ({ consolidationId: cid, reused: false, summary: { attempted: 2, verified: 2, failures: 0, costUsd: 1.2 } }),
        }).notify();

        // Assert
        expect(jobs.get(id)).toMatchObject({ state: 'succeeded', consolidationId: cid });
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
