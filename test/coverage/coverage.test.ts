import { describe, expect, it } from 'vitest';
import { coverageOf, novelClusters, shouldContinue } from '../../src/coverage/coverage.js';

function clusters(...occurrences: number[]): Array<{ occurrence: number }>
{
    return occurrences.map(occurrence => ({ occurrence }));
}

describe('coverageOf', () =>
{
    it('should count observed clusters, singletons and doubletons', () =>
    {
        // Act
        const coverage = coverageOf(clusters(1, 1, 2, 3, 4));

        // Assert
        expect(coverage.observed).toBe(5);
        expect(coverage.f1).toBe(2);
        expect(coverage.f2).toBe(1);
    });

    it('should estimate undiscovered findings with the classic Chao1 form', () =>
    {
        // Arrange: f1 = 4, f2 = 2 → 16 / 4
        const spread = clusters(1, 1, 1, 1, 2, 2, 3);

        // Act
        const coverage = coverageOf(spread);

        // Assert
        expect(coverage.undiscovered).toBe(4);
        expect(coverage.estimatedTotal).toBe(11);
    });

    it('should use the bias-corrected form when no cluster was seen exactly twice', () =>
    {
        // Arrange: f1 = 4, f2 = 0 → 4 * 3 / 2
        const noDoubletons = clusters(1, 1, 1, 1, 3, 4);

        // Act
        const coverage = coverageOf(noDoubletons);

        // Assert
        expect(coverage.undiscovered).toBe(6);
    });

    it('should report nothing undiscovered once every cluster has recurred', () =>
    {
        // Act
        const coverage = coverageOf(clusters(2, 3, 4, 4));

        // Assert
        expect(coverage.f1).toBe(0);
        expect(coverage.undiscovered).toBe(0);
        expect(coverage.estimatedTotal).toBe(4);
    });

    it('should handle an empty consolidation without dividing by zero', () =>
    {
        // Act
        const coverage = coverageOf([]);

        // Assert
        expect(coverage).toEqual({ observed: 0, f1: 0, f2: 0, undiscovered: 0, estimatedTotal: 0 });
    });

    it('should reproduce the real consolidation #3 estimate', () =>
    {
        // Arrange: the 4-run target-repo union — 8 seen once, 3 twice, 1 thrice, 2 in all four
        const consolidationThree = clusters(1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 4, 4);

        // Act
        const coverage = coverageOf(consolidationThree);

        // Assert
        expect(coverage.observed).toBe(14);
        expect(coverage.f1).toBe(8);
        expect(coverage.f2).toBe(3);
        expect(coverage.undiscovered).toBe(11);
    });
});

describe('novelClusters', () =>
{
    it('should count clusters no other run reported', () =>
    {
        // Arrange
        const clusters = [
            { members: [{ runId: 5 }] },
            { members: [{ runId: 1 }, { runId: 5 }] },
            { members: [{ runId: 5 }, { runId: 5 }] },
            { members: [{ runId: 1 }] },
        ];

        // Act
        const novel = novelClusters(clusters, 5);

        // Assert
        expect(novel).toBe(2);
    });

    it('should count nothing when every cluster has an earlier witness', () =>
    {
        // Arrange
        const clusters = [{ members: [{ runId: 1 }, { runId: 5 }] }, { members: [{ runId: 1 }] }];

        // Act + Assert
        expect(novelClusters(clusters, 5)).toBe(0);
    });
});

describe('shouldContinue', () =>
{
    it('should continue while rounds keep adding clusters', () =>
    {
        // Act + Assert
        expect(shouldContinue([{ novelClusters: 3 }, { novelClusters: 1 }])).toBe(true);
    });

    it('should continue when only the latest round was barren', () =>
    {
        // Act + Assert
        expect(shouldContinue([{ novelClusters: 2 }, { novelClusters: 0 }])).toBe(true);
    });

    it('should stop after two consecutive barren rounds', () =>
    {
        // Act + Assert
        expect(shouldContinue([{ novelClusters: 2 }, { novelClusters: 0 }, { novelClusters: 0 }])).toBe(false);
    });

    it('should continue before patience rounds have happened at all', () =>
    {
        // Act + Assert
        expect(shouldContinue([{ novelClusters: 0 }])).toBe(true);
    });

    it('should stop after a single barren round when patience is one', () =>
    {
        // Act + Assert
        expect(shouldContinue([{ novelClusters: 0 }], 1)).toBe(false);
    });
});
