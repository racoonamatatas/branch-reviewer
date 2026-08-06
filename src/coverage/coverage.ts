// How much of the branch is still unreviewed, estimated from what recurrence
// already tells us. Consolidation collects occurrence counts for confidence
// badges; the same counts answer a second question for free — a population
// where most findings were seen once is still being discovered, one where
// findings keep recurring has been swept. That is Chao1, borrowed from
// ecology (f1/f2 are singleton/doubleton species there, cluster occurrences
// here). Structurally typed on { occurrence } so the estimator stays free of
// both the store and the campaign that consumes it.

export interface Coverage
{
    observed: number;        // distinct findings seen so far
    f1: number;              // seen in exactly one run
    f2: number;              // seen in exactly two runs
    undiscovered: number;    // Chao1 estimate of findings not yet seen
    estimatedTotal: number;  // observed + undiscovered
}

export function coverageOf(clusters: Array<{ occurrence: number }>): Coverage
{
    const observed = clusters.length;
    const f1 = clusters.filter(c => c.occurrence === 1).length;
    const f2 = clusters.filter(c => c.occurrence === 2).length;

    // Classic Chao1 divides by f2; with no doubletons at all, the
    // bias-corrected form is the one that stays defined.
    const raw = f2 > 0
        ? (f1 * f1) / (2 * f2)
        : (f1 * (f1 - 1)) / 2;

    // A fraction of a finding means nothing to any caller — this is a count.
    // Clamped because the bias-corrected form yields -0 when f1 is 0.
    const undiscovered = Math.max(0, Math.round(raw));

    return { observed, f1, f2, undiscovered, estimatedTotal: observed + undiscovered };
}

// The stopping rule, deliberately observational: a campaign ends when runs
// stop finding new things, not when the estimate says the tail is small.
// Chao1 on real data here stays high for many rounds (it answers "how much am
// I missing?", which is worth reporting), so gating on it would mean never
// stopping before the run cap — the cap would decide while the report implied
// the statistics had.
export function shouldContinue(rounds: Array<{ newClusters: number }>, patience = 2): boolean
{
    if (rounds.length < patience)
    {
        return true;
    }
    return !rounds.slice(-patience).every(r => r.newClusters === 0);
}
