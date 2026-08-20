import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { campaignCost, clusterGrowth, runCampaign } from '../../src/campaign/campaign.js';
import type { CampaignResult, RoundOutcome } from '../../src/campaign/campaign.js';
import type { RepoClient } from '../../src/github/github.js';
import { sweepInterruptedCampaigns } from '../../src/store/lease.js';
import { ReviewStore } from '../../src/store/store.js';
import type { Finding } from '../../src/store/store.js';
import type { CampaignId } from '../../src/types/ids.js';
import { consolidationId, runId } from '../../src/types/ids.js';

// The loop's two paid boundaries, mocked so the loop itself runs real:
// the reviewer returns canned submissions, the judge is scriptable per call.
const runClusteringMock = vi.hoisted(() => vi.fn());
const runReviewMock = vi.hoisted(() => vi.fn());
const verifyPendingMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/consolidate/consolidate.js', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('../../src/consolidate/consolidate.js')>();
    return { ...original, runClustering: runClusteringMock };
});
vi.mock('../../src/review/review.js', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('../../src/review/review.js')>();
    return { ...original, runReview: runReviewMock };
});
vi.mock('../../src/verify/verify.js', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('../../src/verify/verify.js')>();
    return { ...original, verifyPending: verifyPendingMock };
});

function round(n: number, overrides: Partial<RoundOutcome> = {}): RoundOutcome
{
    return {
        round: n,
        runId: runId(100 + n),
        findings: 5,
        turns: 28,
        costUsd: 2.5,
        consolidationId: consolidationId(n),
        novelClusters: 0,
        ...overrides,
    };
}

function abortedRound(n: number): RoundOutcome
{
    return {
        round: n,
        runId: runId(100 + n),
        findings: 0,
        turns: 20,
        costUsd: 1.25,
        aborted: 'error_max_turns',
        novelClusters: 0,
    };
}

function failedRound(n: number): RoundOutcome
{
    return { round: n, findings: 0, turns: 0, costUsd: 0, failed: 'GitHub API 502', novelClusters: 0 };
}

describe('clusterGrowth', () =>
{
    it('should report new clusters per consolidated round', () =>
    {
        // Arrange
        const rounds = [round(1, { novelClusters: 3 }), round(2, { novelClusters: 1 })];

        // Act
        const growth = clusterGrowth(rounds);

        // Assert
        expect(growth).toEqual([{ round: 1, novelClusters: 3 }, { round: 2, novelClusters: 1 }]);
    });

    it('should exclude aborted rounds, which say nothing about saturation', () =>
    {
        // Arrange
        const rounds = [round(1, { novelClusters: 2 }), abortedRound(2), round(3, { novelClusters: 1 })];

        // Act
        const growth = clusterGrowth(rounds);

        // Assert
        expect(growth.map(g => g.round)).toEqual([1, 3]);
    });

    it('should exclude rounds that threw before producing a run', () =>
    {
        // Arrange
        const rounds = [round(1, { novelClusters: 2 }), failedRound(2)];

        // Act
        const growth = clusterGrowth(rounds);

        // Assert
        expect(growth.map(g => g.round)).toEqual([1]);
    });
});

describe('campaignCost', () =>
{
    it('should roll up review and verification costs separately', () =>
    {
        // Arrange
        const campaign: CampaignResult = {
            rounds: [round(1), round(2)],
            consolidationId: consolidationId(2),
            runIds: [runId(101), runId(102)],
            reviewCostUsd: 5,
            verification: { attempted: 3, verified: 3, failures: 0, costUsd: 2.5 },
            stoppedBy: 'dry',
        };

        // Act
        const cost = campaignCost(campaign);

        // Assert
        expect(cost).toEqual({ reviews: 5, verification: 2.5, total: 7.5 });
    });

    it('should count verification as free when it was skipped', () =>
    {
        // Arrange
        const campaign: CampaignResult = {
            rounds: [round(1)],
            consolidationId: consolidationId(1),
            runIds: [runId(101)],
            reviewCostUsd: 2.5,
            stoppedBy: 'max-runs',
        };

        // Act
        const cost = campaignCost(campaign);

        // Assert
        expect(cost).toEqual({ reviews: 2.5, verification: 0, total: 2.5 });
    });
});

describe('runCampaign', () =>
{
    it('should survive a judge failure: the round keeps its run, the campaign keeps going', async () =>
    {
        // Arrange: three submitted reviews; the first judge call (round 2 —
        // the first with two runs to union) aborts, later calls succeed.
        const store = new ReviewStore(':memory:');
        const client: RepoClient = { compare: async () => [], readFile: async () => '' };
        const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
        runReviewMock.mockResolvedValue({
            status: 'submitted',
            review: { summary: 'reviewed', findings: [{ file: 'src/a.ts', severity: 'warning', title: 'T', detail: 'd' }] },
            filesChanged: 2,
            stats: { turns: 5, costUsd: 1, usage, perModel: {}, streamed: usage, turnUsage: [], compactions: 0 },
        });
        runClusteringMock
            .mockRejectedValueOnce(new Error('Clustering judge failed: error_max_turns'))
            .mockImplementation(async (findings: Finding[]) =>
                [{ memberIds: findings.map(f => f.id), representativeId: findings[0]!.id }]);

        // Act
        const result = await runCampaign(
            store, client,
            { owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main' },
            { maxRuns: 3, verify: false },
        );
        store.close();

        // Assert: round 2's judge abort is recorded on the round, its run
        // survives, and round 3's judge re-unions all three runs.
        expect(result.rounds).toHaveLength(3);
        expect(result.rounds[1]).toMatchObject({
            consolidationFailed: expect.stringContaining('error_max_turns') as string,
        });
        expect(result.rounds[1]?.runId).toBeDefined();
        expect(result.rounds[1]?.consolidationId).toBeUndefined();
        expect(result.consolidationId).toBeDefined();
        expect(result.runIds).toHaveLength(3);
    });

    it('should stop after two consecutive judge failures instead of burning the run cap', async () =>
    {
        // Arrange: reviews keep succeeding (and billing), but the judge is
        // persistently broken — every consolidation attempt throws.
        const store = new ReviewStore(':memory:');
        const client: RepoClient = { compare: async () => [], readFile: async () => '' };
        const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
        runReviewMock.mockResolvedValue({
            status: 'submitted',
            review: { summary: 'reviewed', findings: [{ file: 'src/a.ts', severity: 'warning', title: 'T', detail: 'd' }] },
            filesChanged: 2,
            stats: { turns: 5, costUsd: 1, usage, perModel: {}, streamed: usage, turnUsage: [], compactions: 0 },
        });
        runClusteringMock.mockRejectedValue(new Error('Clustering judge failed: schema rejection'));

        // Act
        const result = await runCampaign(
            store, client,
            { owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main' },
            { maxRuns: 5, verify: false },
        );
        store.close();

        // Assert: round 1 has no judge call (one run is below the union
        // guard); rounds 2 and 3 fail it — two strikes, stop, three rounds
        // billed instead of five.
        expect(result.stoppedBy).toBe('no-consolidation');
        expect(result.rounds).toHaveLength(3);
        expect(result.rounds.filter(r => r.consolidationFailed !== undefined)).toHaveLength(2);
        expect(result.consolidationId).toBeUndefined();
    });

    it('should stop on the first empty-diff round instead of burning the run cap', async () =>
    {
        // Arrange: the compare lists no files — every later round would
        // compare the same base/head.
        const store = new ReviewStore(':memory:');
        const client: RepoClient = { compare: async () => [], readFile: async () => '' };
        const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
        runReviewMock.mockResolvedValue({
            status: 'empty',
            filesChanged: 0,
            stats: { turns: 0, costUsd: 0, usage, perModel: {}, streamed: usage, turnUsage: [], compactions: 0 },
        });

        // Act
        const result = await runCampaign(
            store, client,
            { owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main' },
            { maxRuns: 3, verify: false },
        );

        // Assert: one round, its own stop reason — never 'dry' (an empty
        // compare says nothing about saturation) and never three stored
        // copies of the same nothing.
        expect(result.rounds).toHaveLength(1);
        expect(result.stoppedBy).toBe('empty-diff');
        const runId = result.rounds[0]!.runId!;
        expect(store.getRun(runId)?.status).toBe('empty');
        store.close();
    });
});

describe('runCampaign persistence', () =>
{
    const target = { owner: 'acme', repo: 'widgets', head: 'feature-x', base: 'main' };
    const client: RepoClient = { compare: async () => [], readFile: async () => '' };
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

    function submittedReview(): unknown
    {
        return {
            status: 'submitted',
            review: { summary: 'reviewed', findings: [{ file: 'src/a.ts', severity: 'warning', title: 'T', detail: 'd' }] },
            filesChanged: 2,
            stats: { turns: 5, costUsd: 1, usage, perModel: {}, streamed: usage, turnUsage: [], compactions: 0 },
        };
    }

    function emptyReview(): unknown
    {
        const zero = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
        return {
            status: 'empty',
            filesChanged: 0,
            stats: { turns: 0, costUsd: 0, usage: zero, perModel: {}, streamed: zero, turnUsage: [], compactions: 0 },
        };
    }

    function seedRun(store: ReviewStore): void
    {
        store.saveRun({
            ...target,
            model: 'default',
            status: 'submitted',
            review: { summary: 'seeded', findings: [{ file: 'src/a.ts', severity: 'warning', title: 'T', detail: 'd' }] },
            turns: 5,
            costUsd: 1,
            usage,
            filesChanged: 2,
        });
    }

    it('should record the campaign as it happened: rounds snapshotted, stop reason kept', async () =>
    {
        // Arrange: identical submissions, one all-member cluster — round 2 is
        // the first consolidation and both consolidated rounds are barren, so
        // the loop dries at 3 of 5.
        const store = new ReviewStore(':memory:');
        runReviewMock.mockReset();
        runClusteringMock.mockReset();
        runReviewMock.mockResolvedValue(submittedReview());
        runClusteringMock.mockImplementation(async (findings: Finding[]) =>
            [{ memberIds: findings.map(f => f.id), representativeId: findings[0]!.id }]);
        let announced: CampaignId | undefined;

        // Act
        const result = await runCampaign(store, client, target, {
            maxRuns: 5, verify: false,
            onCampaign: id => announced = id,
        });

        // Assert: the stored record and the returned result are the same story.
        expect(result.campaignId).toBeDefined();
        expect(announced).toBe(result.campaignId);
        const campaign = store.getCampaign(result.campaignId!);
        expect(campaign).toMatchObject({ status: 'finished', stoppedBy: result.stoppedBy });
        expect(campaign?.baselineConsolidationId).toBeUndefined();
        expect(campaign?.rounds).toEqual(result.rounds);
        expect(result.stoppedBy).toBe('dry');
        store.close();
    });

    it('should record the baseline consolidation when stored runs already exist', async () =>
    {
        // Arrange: two prior runs make a baseline; the campaign's own round
        // hits an empty compare and stops.
        const store = new ReviewStore(':memory:');
        seedRun(store);
        seedRun(store);
        runReviewMock.mockReset();
        runClusteringMock.mockReset();
        runReviewMock.mockResolvedValue(emptyReview());
        runClusteringMock.mockImplementation(async (findings: Finding[]) =>
            [{ memberIds: findings.map(f => f.id), representativeId: findings[0]!.id }]);

        // Act
        const result = await runCampaign(store, client, target, { maxRuns: 3, verify: false });

        // Assert
        const campaign = store.getCampaign(result.campaignId!);
        expect(campaign?.baselineConsolidationId).toBeDefined();
        expect(campaign).toMatchObject({ status: 'finished', stoppedBy: 'empty-diff' });
        expect(campaign?.rounds).toEqual(result.rounds);
        store.close();
    });

    it('should fail the campaign record when the loop dies structurally', async () =>
    {
        // Arrange: the baseline judge call is the one throw the loop cannot
        // absorb into a round.
        const store = new ReviewStore(':memory:');
        seedRun(store);
        seedRun(store);
        runReviewMock.mockReset();
        runClusteringMock.mockReset();
        runClusteringMock.mockRejectedValue(new Error('judge burned down'));

        // Act + Assert: the throw still reaches the caller; the record says why.
        await expect(runCampaign(store, client, target, { maxRuns: 3, verify: false }))
            .rejects.toThrow('judge burned down');
        const summaries = store.listCampaigns(target);
        expect(summaries).toHaveLength(1);
        const campaign = store.getCampaign(summaries[0]!.id);
        expect(campaign).toMatchObject({ status: 'failed', error: expect.stringContaining('judge burned down') as string });
        store.close();
    });

    it('should spend the verification phase as `verifying` — a live, gated span — then finish', async () =>
    {
        // Arrange: two submitted rounds so a consolidation exists to verify.
        const store = new ReviewStore(':memory:');
        runReviewMock.mockReset();
        runClusteringMock.mockReset();
        verifyPendingMock.mockReset();
        runReviewMock.mockResolvedValue(submittedReview());
        runClusteringMock.mockImplementation(async (findings: Finding[]) =>
            [{ memberIds: findings.map(f => f.id), representativeId: findings[0]!.id }]);
        let announced: CampaignId | undefined;
        let statusDuringVerification: string | undefined;
        verifyPendingMock.mockImplementation(async () =>
        {
            statusDuringVerification = store.getCampaign(announced!)?.status;
            return { attempted: 1, verified: 1, failures: 0, costUsd: 0.5 };
        });

        // Act
        const result = await runCampaign(store, client, target, {
            maxRuns: 2, verify: true,
            onCampaign: id => announced = id,
        });

        // Assert: the adversarial passes billed inside the record's life,
        // and the stop reason recorded at the loop's end survived to the end.
        expect(statusDuringVerification).toBe('verifying');
        expect(store.getCampaign(result.campaignId!)).toMatchObject({ status: 'finished', stoppedBy: 'max-runs' });
        expect(result.verification).toMatchObject({ verified: 1 });
        store.close();
    });

    it('should fail the record on a verification crash without losing why the loop stopped', async () =>
    {
        // Arrange
        const store = new ReviewStore(':memory:');
        runReviewMock.mockReset();
        runClusteringMock.mockReset();
        verifyPendingMock.mockReset();
        runReviewMock.mockResolvedValue(submittedReview());
        runClusteringMock.mockImplementation(async (findings: Finding[]) =>
            [{ memberIds: findings.map(f => f.id), representativeId: findings[0]!.id }]);
        verifyPendingMock.mockRejectedValue(new Error('verifier exploded'));

        // Act + Assert
        await expect(runCampaign(store, client, target, { maxRuns: 2, verify: true }))
            .rejects.toThrow('verifier exploded');
        expect(store.getCampaign(store.listCampaigns(target)[0]!.id)).toMatchObject({
            status: 'failed',
            error: expect.stringContaining('verifier exploded') as string,
            stoppedBy: 'max-runs',
        });
        store.close();
    });

    it('should latch after the record is externally failed: one actionable warning, not one per round', async () =>
    {
        // Arrange: an external sweep (the degraded-liveness case) fails the
        // row after round 1; rounds 2 and 3 would each hit the state guard.
        const store = new ReviewStore(':memory:');
        runReviewMock.mockReset();
        runClusteringMock.mockReset();
        runReviewMock.mockResolvedValue(submittedReview());
        runClusteringMock.mockImplementation(async (findings: Finding[]) =>
            [{ memberIds: findings.map(f => f.id), representativeId: findings[0]!.id }]);
        let announced: CampaignId | undefined;
        const warnings: string[] = [];
        let failed = false;

        // Act
        await runCampaign(store, client, target, {
            maxRuns: 3, verify: false,
            onCampaign: id => announced = id,
            onWarning: message => warnings.push(message),
            onRun: () =>
            {
                if (!failed)
                {
                    failed = true;
                    store.failCampaign(announced!, 'swept by another process');
                }
            },
        });

        // Assert: exactly one warning, and it names the consequence instead
        // of vaguely reporting the same refused write every round.
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('no longer writable');
        expect(warnings[0]).toContain('will not be persisted');
        store.close();
    });

    it('should hold the liveness lease while looping and leave nothing sweepable after', async () =>
    {
        // Arrange: leases need a real file — the mechanism is the kernel's
        // lock on the lock database, which :memory: stores opt out of.
        const dir = mkdtempSync(join(tmpdir(), 'campaign-lease-'));
        const store = new ReviewStore(join(dir, 'reviews.db'));
        runReviewMock.mockReset();
        runClusteringMock.mockReset();
        runReviewMock.mockResolvedValue(emptyReview());
        const sweptMidLoop: unknown[] = [];

        // Act: probe from inside the loop with the grace window disabled —
        // otherwise the row's youth, not the lease, is what protects it and
        // the test proves nothing about leasing (campaign #3 finding).
        const result = await runCampaign(store, client, target, {
            maxRuns: 2, verify: false,
            onRun: () => sweptMidLoop.push(...sweepInterruptedCampaigns(store, { graceMs: 0 })),
        });

        // Assert: alive while looping, closed and lease-free after.
        expect(sweptMidLoop).toEqual([]);
        expect(store.getCampaign(result.campaignId!)?.status).toBe('finished');
        expect(sweepInterruptedCampaigns(store)).toEqual([]);
        expect(existsSync(join(store.leaseDir!, `campaign-${result.campaignId}.lock`))).toBe(false);
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('should warn and keep looping when a campaign-record write fails', async () =>
    {
        // Arrange: the row is narrative, not evidence — a failed append must
        // cost a warning, never a loop that is billing credit.
        const store = new ReviewStore(':memory:');
        runReviewMock.mockReset();
        runClusteringMock.mockReset();
        runReviewMock.mockResolvedValue(emptyReview());
        vi.spyOn(store, 'appendCampaignRound').mockImplementation(() =>
        {
            throw new Error('disk full');
        });
        const warnings: string[] = [];

        // Act
        const result = await runCampaign(store, client, target, {
            maxRuns: 2, verify: false,
            onWarning: message => warnings.push(message),
        });

        // Assert: the loop finished on its own terms and the record still
        // closed — only the round snapshot is missing, and it was reported.
        expect(result.stoppedBy).toBe('empty-diff');
        expect(warnings.some(w => w.includes('disk full'))).toBe(true);
        expect(store.getCampaign(result.campaignId!)?.status).toBe('finished');
        store.close();
    });
});
