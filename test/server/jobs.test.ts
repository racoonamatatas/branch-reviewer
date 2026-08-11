import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../../src/server/jobs.js';
import type { NewJob } from '../../src/server/jobs.js';
import { consolidationId, jobId, runId } from '../../src/types/ids.js';

let store: JobStore;

beforeEach(() =>
{
    store = new JobStore(':memory:');
});

afterEach(() =>
{
    store.close();
});

function reviewJob(overrides: Partial<NewJob> = {}): NewJob
{
    return {
        kind: 'review',
        owner: 'acme',
        repo: 'widgets',
        head: 'feature/x',
        base: 'main',
        params: { maxTurns: 20 },
        ...overrides,
    } as NewJob;
}

describe('enqueue and get', () =>
{
    it('should round-trip a review job with store-assigned lifecycle defaults', () =>
    {
        // Act
        const id = store.enqueue(reviewJob());
        const job = store.get(id);

        // Assert
        expect(job).toMatchObject({
            id,
            kind: 'review',
            owner: 'acme',
            repo: 'widgets',
            head: 'feature/x',
            base: 'main',
            params: { maxTurns: 20 },
            state: 'queued',
            runIds: [],
        });
        expect(job?.startedAt).toBeUndefined();
        expect(job?.finishedAt).toBeUndefined();
        expect(job?.error).toBeUndefined();
    });

    it('should round-trip campaign params through the JSON column', () =>
    {
        // Arrange
        const campaign: NewJob = {
            kind: 'campaign',
            owner: 'acme',
            repo: 'widgets',
            head: 'feature/x',
            base: 'main',
            params: { maxRuns: 5, patience: 2, verify: true },
        };

        // Act
        const job = store.get(store.enqueue(campaign));

        // Assert
        expect(job?.kind).toBe('campaign');
        expect(job?.params).toEqual({ maxRuns: 5, patience: 2, verify: true });
    });

    it('should return undefined for an unknown id', () =>
    {
        // Act + Assert
        expect(store.get(jobId(99))).toBeUndefined();
    });
});

describe('claimNext', () =>
{
    it('should claim the oldest queued job and stamp startedAt', () =>
    {
        // Arrange
        const first = store.enqueue(reviewJob());
        store.enqueue(reviewJob({ head: 'feature/y' }));

        // Act
        const claimed = store.claimNext();

        // Assert
        expect(claimed?.id).toBe(first);
        expect(claimed?.state).toBe('running');
        expect(claimed?.startedAt).toBeDefined();
    });

    it('should return undefined when nothing is queued', () =>
    {
        // Act + Assert
        expect(store.claimNext()).toBeUndefined();
    });

    it('should not claim a job twice', () =>
    {
        // Arrange
        store.enqueue(reviewJob());

        // Act
        store.claimNext();

        // Assert
        expect(store.claimNext()).toBeUndefined();
    });
});

describe('state transitions', () =>
{
    it('should record runs while running and keep them on success', () =>
    {
        // Arrange
        const id = store.enqueue(reviewJob());
        store.claimNext();

        // Act
        store.recordRun(id, runId(7));
        store.succeed(id, { consolidationId: consolidationId(3) });
        const job = store.get(id);

        // Assert
        expect(job?.state).toBe('succeeded');
        expect(job?.runIds).toEqual([7]);
        expect(job?.consolidationId).toBe(3);
        expect(job?.finishedAt).toBeDefined();
    });

    it('should keep the abort reason on a capped job', () =>
    {
        // Arrange
        const id = store.enqueue(reviewJob());
        store.claimNext();

        // Act
        store.abort(id, 'error_max_turns');

        // Assert
        expect(store.get(id)).toMatchObject({ state: 'aborted', error: 'error_max_turns' });
    });

    it('should keep the error on a failed job', () =>
    {
        // Arrange
        const id = store.enqueue(reviewJob());
        store.claimNext();

        // Act
        store.fail(id, 'GitHub compare returned 404');

        // Assert
        expect(store.get(id)).toMatchObject({ state: 'failed', error: 'GitHub compare returned 404' });
    });

    it('should refuse to complete a job that is not running', () =>
    {
        // Arrange
        const id = store.enqueue(reviewJob());

        // Act + Assert
        expect(() => store.succeed(id)).toThrow('it is queued, not running');
    });

    it('should refuse to record a run on a finished job', () =>
    {
        // Arrange
        const id = store.enqueue(reviewJob());
        store.claimNext();
        store.succeed(id);

        // Act + Assert
        expect(() => store.recordRun(id, runId(1))).toThrow('it is succeeded, not running');
    });

    it('should name the missing job', () =>
    {
        // Act + Assert
        expect(() => store.fail(jobId(42), 'x')).toThrow('No job #42');
    });
});

describe('cancel', () =>
{
    it('should cancel a queued job', () =>
    {
        // Arrange
        const id = store.enqueue(reviewJob());

        // Act
        store.cancel(id);

        // Assert
        expect(store.get(id)?.state).toBe('cancelled');
    });

    it('should refuse to cancel a running job: its credit is already spent', () =>
    {
        // Arrange
        const id = store.enqueue(reviewJob());
        store.claimNext();

        // Act + Assert
        expect(() => store.cancel(id)).toThrow('it is running, not held or queued');
    });

    it('should not let a cancelled job be claimed', () =>
    {
        // Arrange
        const id = store.enqueue(reviewJob());
        store.cancel(id);

        // Act + Assert
        expect(store.claimNext()).toBeUndefined();
        expect(store.get(id)?.state).toBe('cancelled');
    });
});

describe('held jobs', () =>
{
    it('should keep a held job out of the worker\'s reach until released', () =>
    {
        // Arrange
        const id = store.enqueue(reviewJob(), { held: true });

        // Act + Assert: invisible to claimNext while held...
        expect(store.get(id)?.state).toBe('held');
        expect(store.claimNext()).toBeUndefined();

        // ...and claimable the moment a human releases it.
        store.release(id);
        expect(store.get(id)?.state).toBe('queued');
        expect(store.claimNext()?.id).toBe(id);
    });

    it('should cancel a held job: the fuse works before release too', () =>
    {
        // Arrange
        const id = store.enqueue(reviewJob(), { held: true });

        // Act
        store.cancel(id);

        // Assert
        expect(store.get(id)?.state).toBe('cancelled');
    });

    it('should refuse to release a job that is not held', () =>
    {
        // Arrange
        const queued = store.enqueue(reviewJob());
        const cancelled = store.enqueue(reviewJob({ head: 'feature/y' }), { held: true });
        store.cancel(cancelled);

        // Act + Assert
        expect(() => store.release(queued)).toThrow('it is queued, not held');
        expect(() => store.release(cancelled)).toThrow('it is cancelled, not held');
    });

    it('should count a held job in hasJobFor: proposed work still blocks the trigger', () =>
    {
        // Arrange
        store.enqueue(reviewJob(), { held: true });

        // Act + Assert
        expect(store.hasJobFor('acme', 'widgets', 'feature/x')).toBe(true);
    });
});

describe('hasJobFor', () =>
{
    it('should find a job by target head in any state, and miss unknown heads', () =>
    {
        // Arrange: a cancelled job still counts — automation must not
        // override a human's cancel.
        const id = store.enqueue(reviewJob());
        store.cancel(id);

        // Act + Assert
        expect(store.hasJobFor('acme', 'widgets', 'feature/x')).toBe(true);
        expect(store.hasJobFor('acme', 'widgets', 'feature/z')).toBe(false);
        expect(store.hasJobFor('acme', 'other', 'feature/x')).toBe(false);
    });
});

describe('recoverInterrupted', () =>
{
    it('should fail running jobs at startup and report them', () =>
    {
        // Arrange: one running (interrupted), one queued (untouched).
        const interrupted = store.enqueue(reviewJob());
        store.claimNext();
        const queued = store.enqueue(reviewJob({ head: 'feature/y' }));

        // Act
        const recovered = store.recoverInterrupted();

        // Assert
        expect(recovered).toEqual([interrupted]);
        expect(store.get(interrupted)).toMatchObject({
            state: 'failed',
            error: expect.stringContaining('Interrupted') as string,
        });
        expect(store.get(queued)?.state).toBe('queued');
    });

    it('should do nothing on a clean store', () =>
    {
        // Act + Assert
        expect(store.recoverInterrupted()).toEqual([]);
    });
});

describe('list', () =>
{
    it('should summarize newest first with run counts', () =>
    {
        // Arrange
        const first = store.enqueue(reviewJob());
        const second = store.enqueue(reviewJob({ head: 'feature/y' }));
        store.claimNext();
        store.recordRun(first, runId(1));
        store.recordRun(first, runId(2));

        // Act
        const summaries = store.list();

        // Assert
        expect(summaries.map(s => s.id)).toEqual([second, first]);
        expect(summaries[1]).toMatchObject({
            kind: 'review',
            state: 'running',
            target: 'acme/widgets feature/x → main',
            runCount: 2,
        });
    });
});
