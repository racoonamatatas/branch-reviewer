import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PullRequest, PullSource } from '../../src/github/github.js';
import { JobStore } from '../../src/server/jobs.js';
import { pollOnce, WatchStore } from '../../src/server/trigger.js';
import type { TriggerDeps } from '../../src/server/trigger.js';
import { watchId } from '../../src/types/ids.js';

let watches: WatchStore;
let jobs: JobStore;

beforeEach(() =>
{
    watches = new WatchStore(':memory:');
    jobs = new JobStore(':memory:');
});

afterEach(() =>
{
    watches.close();
    jobs.close();
});

function pull(number: number, overrides: Partial<PullRequest> = {}): PullRequest
{
    return {
        number,
        title: `PR ${number}`,
        headSha: `sha-${number}`,
        headRef: `feature/${number}`,
        baseRef: 'main',
        draft: false,
        labels: ['agent-review'],
        ...overrides,
    };
}

// One fake source per repo; unknown repos throw like the real API would.
function sourceFor(byRepo: Record<string, PullRequest[] | Error>): TriggerDeps['pullSourceFor']
{
    return (owner, repo): PullSource => ({
        listOpenPulls: async () =>
        {
            const entry = byRepo[`${owner}/${repo}`];
            if (entry === undefined || entry instanceof Error)
            {
                throw entry ?? new Error('GitHub API 404');
            }
            return entry;
        },
    });
}

function deps(byRepo: Record<string, PullRequest[] | Error>, overrides: Partial<TriggerDeps> = {}): TriggerDeps
{
    return { watches, jobs, pullSourceFor: sourceFor(byRepo), ...overrides };
}

describe('WatchStore', () =>
{
    it('should round-trip a watch', () =>
    {
        // Act
        const id = watches.add({ owner: 'acme', repo: 'widgets', label: 'agent-review' });

        // Assert
        expect(watches.list()).toMatchObject([
            { id, owner: 'acme', repo: 'widgets', label: 'agent-review' },
        ]);
    });

    it('should refuse a duplicate watch by name', () =>
    {
        // Arrange
        watches.add({ owner: 'acme', repo: 'widgets', label: 'agent-review' });

        // Act + Assert
        expect(() => watches.add({ owner: 'acme', repo: 'widgets', label: 'agent-review' }))
            .toThrow('Already watching acme/widgets for label "agent-review"');
    });

    it('should allow the same repo under a different label', () =>
    {
        // Arrange
        watches.add({ owner: 'acme', repo: 'widgets', label: 'agent-review' });

        // Act
        watches.add({ owner: 'acme', repo: 'widgets', label: 'security-review' });

        // Assert
        expect(watches.list()).toHaveLength(2);
    });

    it('should remove a watch and name a missing one', () =>
    {
        // Arrange
        const id = watches.add({ owner: 'acme', repo: 'widgets', label: 'agent-review' });

        // Act
        watches.remove(id);

        // Assert
        expect(watches.list()).toEqual([]);
        expect(() => watches.remove(watchId(99))).toThrow('No watch #99');
    });
});

describe('pollOnce', () =>
{
    beforeEach(() =>
    {
        watches.add({ owner: 'acme', repo: 'widgets', label: 'agent-review' });
    });

    it('should enqueue a review job for a labeled non-draft PR, head pinned to the SHA', async () =>
    {
        // Act
        const report = await pollOnce(deps({ 'acme/widgets': [pull(7)] }));

        // Assert
        expect(report).toMatchObject({ skipped: 0, capped: 0, errors: [] });
        expect(report.enqueued).toHaveLength(1);
        expect(jobs.get(report.enqueued[0]!)).toMatchObject({
            kind: 'review',
            owner: 'acme',
            repo: 'widgets',
            head: 'sha-7',
            base: 'main',
            state: 'queued',
            params: {},
        });
    });

    it('should ignore drafts and PRs without the trigger label', async () =>
    {
        // Act
        const report = await pollOnce(deps({
            'acme/widgets': [
                pull(1, { draft: true }),
                pull(2, { labels: ['bug'] }),
                pull(3, { labels: [] }),
            ],
        }));

        // Assert
        expect(report).toEqual({ enqueued: [], skipped: 0, capped: 0, errors: [] });
    });

    it('should skip a head SHA that already has a job, whatever its state', async () =>
    {
        // Arrange: one job cancelled by a human, one still queued.
        const cancelled = jobs.enqueue({
            kind: 'review', owner: 'acme', repo: 'widgets', head: 'sha-1', base: 'main', params: {},
        });
        jobs.cancel(cancelled);
        jobs.enqueue({
            kind: 'review', owner: 'acme', repo: 'widgets', head: 'sha-2', base: 'main', params: {},
        });

        // Act
        const report = await pollOnce(deps({ 'acme/widgets': [pull(1), pull(2), pull(3)] }));

        // Assert: only the unseen SHA lands.
        expect(report.skipped).toBe(2);
        expect(report.enqueued).toHaveLength(1);
        expect(jobs.get(report.enqueued[0]!)?.head).toBe('sha-3');
    });

    it('should trigger again on a new push: new SHA, new job', async () =>
    {
        // Arrange: the PR was reviewed at sha-old, then force-pushed.
        jobs.enqueue({
            kind: 'review', owner: 'acme', repo: 'widgets', head: 'sha-old', base: 'main', params: {},
        });

        // Act
        const report = await pollOnce(deps({ 'acme/widgets': [pull(7, { headSha: 'sha-new' })] }));

        // Assert
        expect(report.enqueued).toHaveLength(1);
        expect(jobs.get(report.enqueued[0]!)?.head).toBe('sha-new');
    });

    it('should stop at the per-cycle cap and count what it deferred', async () =>
    {
        // Act
        const report = await pollOnce(deps(
            { 'acme/widgets': [pull(1), pull(2), pull(3)] },
            { maxEnqueuesPerCycle: 2 },
        ));

        // Assert
        expect(report.enqueued).toHaveLength(2);
        expect(report.capped).toBe(1);
    });

    it('should keep polling other watches when one repo fails', async () =>
    {
        // Arrange
        watches.add({ owner: 'acme', repo: 'gone', label: 'agent-review' });

        // Act
        const report = await pollOnce(deps({
            'acme/widgets': [pull(7)],
            'acme/gone': new Error('GitHub API 404'),
        }));

        // Assert
        expect(report.enqueued).toHaveLength(1);
        expect(report.errors).toEqual(['acme/gone: GitHub API 404']);
    });

    it('should report each enqueue as an event', async () =>
    {
        // Arrange
        const events: string[] = [];

        // Act
        await pollOnce(deps(
            { 'acme/widgets': [pull(7, { headSha: 'abcdef0123456789' })] },
            { onEvent: event => events.push(event) },
        ));

        // Assert
        expect(events).toEqual(['acme/widgets PR #7 (abcdef0) enqueued as job #1']);
    });

    it('should do nothing with no watches', async () =>
    {
        // Arrange
        watches.remove(watches.list()[0]!.id);

        // Act + Assert
        expect(await pollOnce(deps({}))).toEqual({ enqueued: [], skipped: 0, capped: 0, errors: [] });
    });
});
