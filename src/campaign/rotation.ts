// A campaign round's slice of the diversity rotation: which lens it reviews
// under and, when a roster was given, which model. Picked from the target's
// history, not the round number — a round-numbered cycle restarted on every
// campaign, so a follow-up campaign re-spent its first round on a generalist
// pass the stored runs already held, and with four-round caps against five
// slots the `tests` lens never ran (two campaigns on one target, eight rounds, zero
// tests rounds). Least-sampled-first resumes where the target's evidence
// leaves off, whatever campaign or CLI flag produced it.

import { LENSES } from '../review/lenses.js';
import type { Lens } from '../review/lenses.js';

// What one earlier round contributed to the rotation. Structural so stored
// runs and this campaign's own picks feed the same tally.
export interface RotationSample
{
    lens?: string;
    model?: string;
}

export interface RoundPick
{
    lens?: Lens;    // absent = the generalist slot
    model?: string; // absent = no roster; the caller's single model applies
}

// The generalist slot leads the order, so a target with no history plays out
// exactly as the old cycle did: generalist, then each lens in LENSES order.
const SLOTS: readonly [Lens | undefined, ...Lens[]] = [undefined, ...LENSES];

export function nextRound(
    history: readonly RotationSample[],
    opts: { rotateLenses: boolean; models?: readonly string[] },
): RoundPick
{
    const lens = opts.rotateLenses ? leastSampled(SLOTS, slot => count(history, s => s.lens === slot?.name)) : undefined;
    const [first, ...rest] = opts.models ?? [];
    if (first === undefined)
    {
        return lens !== undefined ? { lens } : {};
    }

    // The model least paired with this lens first, so cross-model agreement
    // can accrue per lens rather than each lens settling on one model; the
    // model's overall count breaks ties, so a fresh roster still alternates.
    // Scaling the pair count past any possible total makes the sum compare
    // lexicographically.
    const model = leastSampled([first, ...rest], m =>
        count(history, s => s.model === m && s.lens === lens?.name) * (history.length + 1)
            + count(history, s => s.model === m));
    return { ...(lens !== undefined ? { lens } : {}), model };
}

// Ties go to the earlier candidate, which keeps every pick deterministic.
function leastSampled<T>(candidates: readonly [T, ...T[]], tally: (candidate: T) => number): T
{
    let best = candidates[0];
    let bestCount = tally(best);
    for (const candidate of candidates.slice(1))
    {
        const n = tally(candidate);
        if (n < bestCount)
        {
            best = candidate;
            bestCount = n;
        }
    }
    return best;
}

function count(history: readonly RotationSample[], match: (sample: RotationSample) => boolean): number
{
    return history.filter(match).length;
}
