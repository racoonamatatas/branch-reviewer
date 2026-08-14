// How much of the branch is still unreviewed, estimated from what recurrence
// already tells us. Consolidation collects occurrence counts for confidence
// badges; the same counts answer a second question for free — a population
// where most findings were seen once is still being discovered, one where
// findings keep recurring has been swept. That is a capture-recapture
// estimator (Chao1), borrowed from ecology (f1/f2 are singleton/doubleton
// species there, cluster occurrences here). Structurally typed on
// { occurrence } so the estimator stays free of both the store and the
// campaign that consumes it.
//
// Honesty caveat, owned rather than hidden: Chao1 assumes independent
// samples, and these runs are anything but — same model, same prompt, same
// diff, back-to-back on a shared prompt cache. Correlation inflates f1
// relative to f2, which biases the estimate of the unseen tail UPWARD. That
// is why the number on real data stays high for many rounds: partly a
// property of code review, partly the violated assumption showing. Report it
// as an optimistic ceiling on what remains ("at most roughly this much
// unseen credibility is left"), never as a measurement — and never gate on
// it (see shouldContinue).

import type { RunId } from '../types/ids.js';

export interface Coverage
{
    observed: number;        // distinct findings seen so far
    f1: number;              // seen in exactly one run
    f2: number;              // seen in exactly two runs
    undiscovered: number;    // estimate of findings not yet seen
    estimatedTotal: number;  // observed + undiscovered
}

// Coverage's own input rule, owned here instead of re-implemented by every
// consumer: a refuted cluster is not a discovered finding, and counting it
// would inflate both `observed` and the estimate of what remains unseen.
// Verdicts inherit across consolidations by member set, so mid-campaign
// refutations from earlier passes still apply wherever this is used.
export function verifiableClusters<T extends { verificationStatus: string }>(clusters: T[]): T[]
{
    return clusters.filter(c => c.verificationStatus !== 'refuted');
}

export function coverageOf(clusters: Array<{ occurrence: number }>): Coverage
{
    const observed = clusters.length;
    const f1 = clusters.filter(c => c.occurrence === 1).length;
    const f2 = clusters.filter(c => c.occurrence === 2).length;

    // The bias-corrected Chao1 form, used for every input — not just the
    // f2 = 0 boundary. Mixing the classic form (f1²/2f2) with the corrected
    // one at the boundary made the estimate discontinuous the wrong way:
    // f1=10,f2=1 gave 50 while f1=10,f2=0 gave 45, so losing the only
    // doubleton *lowered* the unseen estimate. One form, no seam.
    const raw = (f1 * (f1 - 1)) / (2 * (f2 + 1));

    // A fraction of a finding means nothing to any caller — this is a count.
    // Clamped because the bias-corrected form yields -0 when f1 is 0.
    const undiscovered = Math.max(0, Math.round(raw));

    return { observed, f1, f2, undiscovered, estimatedTotal: observed + undiscovered };
}

// The newest run's marginal yield: clusters no other run reported. Measured
// inside one partition on purpose — comparing cluster counts between rounds
// would be measuring the judge, not the branch, because each round re-judges
// from scratch and a merge of two previously separate clusters can flatten or
// reverse the count while the run really did find something.
export function novelClusters(clusters: Array<{ members: Array<{ runId: RunId }> }>, run: RunId): number
{
    return clusters.filter(c => c.members.every(m => m.runId === run)).length;
}

// The stopping rule, deliberately observational: a campaign ends when runs
// stop finding new things, not when the estimate says the tail is small.
// The estimate on real data here stays high for many rounds (it answers "how much am
// I missing?", which is worth reporting), so gating on it would mean never
// stopping before the run cap — the cap would decide while the report implied
// the statistics had.
export function shouldContinue(rounds: Array<{ novelClusters: number }>, patience = 2): boolean
{
    if (rounds.length < patience)
    {
        return true;
    }
    return !rounds.slice(-patience).every(r => r.novelClusters === 0);
}
