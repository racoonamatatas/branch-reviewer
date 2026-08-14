import { describe, expect, it } from 'vitest';
import { LENSES, lensFor } from '../../src/review/lenses.js';

describe('lensFor', () =>
{
    it('should keep round 1 generalist so the baseline stays comparable with stored runs', () =>
    {
        // Assert
        expect(lensFor(1)).toBeUndefined();
    });

    it('should cycle every lens once before re-entering the generalist slot', () =>
    {
        // Act: one full cycle plus the wrap-around round.
        const cycle = [1, 2, 3, 4, 5, 6].map(round => lensFor(round)?.name);

        // Assert
        expect(cycle).toEqual([undefined, ...LENSES.map(l => l.name), undefined]);
        expect(lensFor(7)?.name).toBe(LENSES[0]?.name);
    });
});
