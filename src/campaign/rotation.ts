// A campaign round's slice of the diversity rotation: which lens it reviews
// under and, when a roster was given, which model. Picked from the target's
// history, not the round number — a round-numbered cycle restarted on every
// campaign, so a follow-up campaign re-spent its first round on a generalist
// pass the stored runs already held, and with four-round caps against five
// slots the `tests` lens never ran (two campaigns on one target, eight
// rounds, zero tests rounds). Least-sampled-first resumes where the target's
// evidence leaves off, whatever campaign or CLI flag produced it.

import { LENSES } from '../review/lenses.js';
import type { Lens } from '../review/lenses.js';

// What one earlier round contributed to the rotation. Structural so stored
// runs and this campaign's own picks feed the same tally.
export interface RotationSample
{
    lens?: string;
    model?: string;
}

// Stored runs and this campaign's own picks weigh differently, so they are
// kept apart rather than concatenated.
export interface RotationHistory
{
    stored: readonly RotationSample[];
    campaign: readonly RotationSample[];
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
    history: RotationHistory,
    opts: { rotateLenses: boolean; models?: readonly string[] },
): RoundPick
{
    // A campaign visits every slot once before repeating any; stored history
    // only orders the visit. Catch-up by raw count handed a starved slot
    // several rounds in a row — under one model, identical prompts riding
    // each other's cache: correlated samples that inflate occurrence and,
    // yielding nothing new after the first, trip patience into a false `dry`
    // (run-132 finding). The starved slot instead leads each campaign until
    // it has caught up.
    const all = [...history.stored, ...history.campaign];
    const lens = opts.rotateLenses
        ? leastSampled(SLOTS, slot => lexicographic(
            count(history.campaign, s => s.lens === slot?.name),
            count(history.stored, s => s.lens === slot?.name),
            all.length))
        : undefined;

    const [first, ...rest] = opts.models ?? [];
    if (first === undefined)
    {
        return lens !== undefined ? { lens } : {};
    }

    // The model least paired with this lens first, so cross-model agreement
    // can accrue per lens rather than each lens settling on one model; the
    // model's overall count breaks ties, so a fresh roster still alternates.
    const model = leastSampled([first, ...rest], m => lexicographic(
        count(all, s => s.model === m && s.lens === lens?.name),
        count(all, s => s.model === m),
        all.length));
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

// (major, minor) as one comparable number: scaling the major key past the
// largest possible minor (`bound`, a count over the same samples) keeps the
// order lexicographic.
function lexicographic(major: number, minor: number, bound: number): number
{
    return major * (bound + 1) + minor;
}

function count(samples: readonly RotationSample[], match: (sample: RotationSample) => boolean): number
{
    return samples.filter(match).length;
}
