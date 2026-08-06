import { describe, expect, it } from 'vitest';
import { campaignCost, clusterGrowth } from '../../src/campaign/campaign.js';
import type { CampaignResult, RoundOutcome } from '../../src/campaign/campaign.js';
import { consolidationId, runId } from '../../src/types/ids.js';

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
