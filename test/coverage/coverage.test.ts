import { describe, expect, it } from 'vitest';
import { coverageOf, novelClusters, shouldContinue } from '../../src/coverage/coverage.js';
import { runId } from '../../src/types/ids.js';

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

    it('should estimate undiscovered findings with the bias-corrected form', () =>
    {
        // Arrange: f1 = 4, f2 = 2 → 4·3 / (2·3) = 2
        const spread = clusters(1, 1, 1, 1, 2, 2, 3);

        // Act
        const coverage = coverageOf(spread);

        // Assert
        expect(coverage.undiscovered).toBe(2);
        expect(coverage.estimatedTotal).toBe(9);
    });

    it('should stay defined with no doubletons at all', () =>
    {
        // Arrange: f1 = 4, f2 = 0 → 4·3 / 2
        const noDoubletons = clusters(1, 1, 1, 1, 3, 4);

        // Act
        const coverage = coverageOf(noDoubletons);

        // Assert
        expect(coverage.undiscovered).toBe(6);
    });

    it('should never estimate less unseen after losing a doubleton: one form, no seam', () =>
    {
        // Arrange: the old classic/corrected mix gave 50 at f2=1 but 45 at
        // f2=0 — losing the only doubleton lowered the unseen estimate.
        const tenSingletonsOneDoubleton = clusters(...Array<number>(10).fill(1), 2);
        const tenSingletonsNoDoubleton = clusters(...Array<number>(10).fill(1));

        // Act + Assert
        expect(coverageOf(tenSingletonsNoDoubleton).undiscovered)
            .toBeGreaterThanOrEqual(coverageOf(tenSingletonsOneDoubleton).undiscovered);
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

    it('should reproduce the real consolidation #3 shape', () =>
    {
        // Arrange: the reference target's 4-run union — 8 seen once, 3 twice,
        // 1 thrice, 2 in all four. The classic form put the estimate at 11;
        // the bias-corrected form used everywhere now gives 8·7/(2·4) = 7.
        const consolidationThree = clusters(1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 4, 4);

        // Act
        const coverage = coverageOf(consolidationThree);

        // Assert
        expect(coverage.observed).toBe(14);
        expect(coverage.f1).toBe(8);
        expect(coverage.f2).toBe(3);
        expect(coverage.undiscovered).toBe(7);
    });
});

describe('novelClusters', () =>
{
    it('should count clusters no other run reported', () =>
    {
        // Arrange
        const clusters = [
            { members: [{ runId: runId(5) }] },
            { members: [{ runId: runId(1) }, { runId: runId(5) }] },
            { members: [{ runId: runId(5) }, { runId: runId(5) }] },
            { members: [{ runId: runId(1) }] },
        ];

        // Act
        const novel = novelClusters(clusters, runId(5));

        // Assert
        expect(novel).toBe(2);
    });

    it('should count nothing when every cluster has an earlier witness', () =>
    {
        // Arrange
        const clusters = [{ members: [{ runId: runId(1) }, { runId: runId(5) }] }, { members: [{ runId: runId(1) }] }];

        // Act + Assert
        expect(novelClusters(clusters, runId(5))).toBe(0);
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
