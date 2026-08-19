import { describe, expect, it, vi } from 'vitest';
import { campaignCost, clusterGrowth, runCampaign } from '../../src/campaign/campaign.js';
import type { CampaignResult, RoundOutcome } from '../../src/campaign/campaign.js';
import type { RepoClient } from '../../src/github/github.js';
import { ReviewStore } from '../../src/store/store.js';
import type { Finding } from '../../src/store/store.js';
import { consolidationId, runId } from '../../src/types/ids.js';

// The loop's two paid boundaries, mocked so the loop itself runs real:
// the reviewer returns canned submissions, the judge is scriptable per call.
const runClusteringMock = vi.hoisted(() => vi.fn());
const runReviewMock = vi.hoisted(() => vi.fn());
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
});
