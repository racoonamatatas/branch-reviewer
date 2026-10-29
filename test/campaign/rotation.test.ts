import { describe, expect, it } from 'vitest';
import { nextRound } from '../../src/campaign/rotation.js';
import type { RotationSample } from '../../src/campaign/rotation.js';
import { LENSES } from '../../src/review/lenses.js';

// Plays a campaign of `rounds` picks forward from `history`, feeding each
// pick back into the tally the way the campaign loop does.
function play(history: RotationSample[], rounds: number, models?: string[]): RotationSample[]
{
    const tally = [...history];
    const picks: RotationSample[] = [];
    for (let i = 0; i < rounds; i++)
    {
        const pick = nextRound(tally, { rotateLenses: true, ...(models !== undefined ? { models } : {}) });
        const sample = {
            ...(pick.lens !== undefined ? { lens: pick.lens.name } : {}),
            ...(pick.model !== undefined ? { model: pick.model } : {}),
        };
        tally.push(sample);
        picks.push(sample);
    }
    return picks;
}

const names = LENSES.map(l => l.name);

describe('nextRound', () =>
{
    it('should open a fresh target with the generalist slot, then each lens in order', () =>
    {
        // Act: one full cycle plus the wrap-around round.
        const picks = play([], LENSES.length + 2);

        // Assert
        expect(picks.map(p => p.lens)).toEqual([undefined, ...names, undefined]);
    });

    it('should resume a follow-up campaign at the slot earlier campaigns never reached', () =>
    {
        // Arrange: two four-round campaigns' worth of history — the live
        // shape that never got to the last lens.
        const firstFour = [undefined, ...names.slice(0, 3)];
        const history = [...firstFour, ...firstFour].map(lens => (lens !== undefined ? { lens } : {}));

        // Act
        const picks = play(history, 4);

        // Assert: the starved slot catches up to the others' count before
        // the ties resume in slot order.
        expect(picks.map(p => p.lens)).toEqual([names[3], names[3], undefined, names[0]]);
    });

    it('should count unlensed runs as generalist samples', () =>
    {
        // Arrange: runs from before rotation (or with it off) carry no lens.
        const history: RotationSample[] = [{ model: 'm' }, { model: 'm' }];

        // Act
        const pick = nextRound(history, { rotateLenses: true });

        // Assert
        expect(pick.lens?.name).toBe(names[0]);
    });

    it('should alternate a fresh roster exactly as the old round-number cycle did', () =>
    {
        // Act
        const picks = play([], 4, ['a', 'b']);

        // Assert
        expect(picks.map(p => p.model)).toEqual(['a', 'b', 'a', 'b']);
    });

    it('should hand a lens to the model that has not reviewed under it yet', () =>
    {
        // Arrange: 'a' already took the generalist slot twice, 'b' never did,
        // though 'b' is the busier model overall.
        const history: RotationSample[] = [
            { model: 'a' }, { model: 'a' },
            { lens: names[0]!, model: 'b' }, { lens: names[1]!, model: 'b' }, { lens: names[2]!, model: 'b' },
            ...names.map(lens => ({ lens, model: 'a' })),
            ...names.map(lens => ({ lens, model: 'b' })),
        ];

        // Act
        const pick = nextRound(history, { rotateLenses: false, models: ['a', 'b'] });

        // Assert: the pair count wins over the overall count.
        expect(pick.lens).toBeUndefined();
        expect(pick.model).toBe('b');
    });

    it('should leave the model to the caller when no roster is given', () =>
    {
        // Act
        const pick = nextRound([], { rotateLenses: false, models: [] });

        // Assert
        expect(pick).toEqual({});
    });
});
