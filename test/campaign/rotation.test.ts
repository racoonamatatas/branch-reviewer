import { describe, expect, it } from 'vitest';
import { nextRound } from '../../src/campaign/rotation.js';
import type { RotationSample } from '../../src/campaign/rotation.js';
import { LENSES } from '../../src/review/lenses.js';

// Plays a campaign of `rounds` picks over `stored`, feeding each pick back
// into the campaign's own tally the way the campaign loop does.
function play(stored: RotationSample[], rounds: number, models?: string[]): RotationSample[]
{
    const campaign: RotationSample[] = [];
    for (let i = 0; i < rounds; i++)
    {
        const pick = nextRound({ stored, campaign }, { rotateLenses: true, ...(models !== undefined ? { models } : {}) });
        campaign.push({
            ...(pick.lens !== undefined ? { lens: pick.lens.name } : {}),
            ...(pick.model !== undefined ? { model: pick.model } : {}),
        });
    }
    return campaign;
}

const names = LENSES.map(l => l.name);

const starved = names.at(-1)!;

// Two campaigns that each stopped one slot short: the live shape that never
// got to the last lens.
function twoShortCampaigns(): RotationSample[]
{
    const reached = [undefined, ...names.slice(0, -1)];
    return [...reached, ...reached].map(lens => (lens !== undefined ? { lens } : {}));
}

describe('nextRound', () =>
{
    it('should keep lens names unique, since slots are tallied by name', () =>
    {
        // Assert: a duplicate would always tie and the later one never run.
        expect(new Set(names).size).toBe(LENSES.length);
    });

    it('should open a fresh target with the generalist slot, then each lens in order', () =>
    {
        // Act: one full cycle plus the wrap-around round.
        const picks = play([], LENSES.length + 2);

        // Assert
        expect(picks.map(p => p.lens)).toEqual([undefined, ...names, undefined]);
    });

    it('should resume a follow-up campaign at the slot earlier campaigns never reached', () =>
    {
        // Act
        const picks = play(twoShortCampaigns(), LENSES.length + 1);

        // Assert: the starved slot leads, once; the rest follow in slot order
        // and nothing repeats until every slot has had a round.
        expect(picks.map(p => p.lens)).toEqual([starved, undefined, ...names.slice(0, -1)]);
    });

    it('should lead each later campaign with a still-starved slot until it catches up', () =>
    {
        // Arrange: the follow-up campaign got only one round in.
        const stored = [...twoShortCampaigns(), { lens: starved }];

        // Act
        const picks = play(stored, 1);

        // Assert
        expect(picks.map(p => p.lens)).toEqual([starved]);
    });

    it('should count unlensed runs as generalist samples', () =>
    {
        // Arrange: runs from before rotation (or with it off) carry no lens.
        const stored: RotationSample[] = [{ model: 'm' }, { model: 'm' }];

        // Act
        const pick = nextRound({ stored, campaign: [] }, { rotateLenses: true });

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

    it('should hand the picked lens to the model that has not reviewed under it, over the less-used model', () =>
    {
        // Arrange: the generalist slot is least sampled, and only 'b' has
        // reviewed under it — though 'a' is far busier overall.
        const stored: RotationSample[] = [
            { model: 'b' },
            ...names.map(lens => ({ lens, model: 'b' })),
            ...names.flatMap(lens => [{ lens, model: 'a' }, { lens, model: 'a' }]),
        ];

        // Act
        const pick = nextRound({ stored, campaign: [] }, { rotateLenses: true, models: ['a', 'b'] });

        // Assert: the pair count wins over the overall count.
        expect(pick.lens).toBeUndefined();
        expect(pick.model).toBe('a');
    });

    it('should leave the model to the caller when no roster is given', () =>
    {
        // Act
        const pick = nextRound({ stored: [], campaign: [] }, { rotateLenses: false, models: [] });

        // Assert
        expect(pick).toEqual({});
    });
});
