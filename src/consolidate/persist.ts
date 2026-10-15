// Store-aware consolidation: cluster a target's stored findings and persist
// the partition. Shared by the campaign loop and the verify job — policy
// (how many runs are enough, when to re-consolidate) stays with the caller;
// this module owns the mechanics of findings → judge → validated partition
// → rows.

import { ClusteringError, distinctRuns, maxSeverity, runClustering } from './consolidate.js';
import type { ClusteringOptions } from './consolidate.js';
import type { Consolidation, Finding, ReviewStore, Run } from '../store/store.js';
import type { Target } from '../types/target.js';

// Every stored submitted run of this target, oldest first — the round order
// a campaign would have produced. The quad filter (base included) is pushed
// into the store: a campaign re-reads this on every round, and pulling the
// whole runs table to filter in JS grew with the database, not the target.
// 'empty' runs never qualify by the status check alone: they are not
// samples, and letting them in would inflate the verifier's "1 of N runs"
// denominator and churn the runIds set that verifyTarget's reuse check
// compares, forcing paid re-consolidations of unchanged findings. (The store
// migrates old submitted + filesChanged 0 rows to 'empty', so no second tell
// is needed here.)
export function submittedRunsFor(store: ReviewStore, target: Target): Run[]
{
    const runs: Run[] = [];
    for (const summary of store.listRuns(target))
    {
        if (summary.status !== 'submitted')
        {
            continue;
        }
        const run = store.getRun(summary.id);
        if (run !== undefined)
        {
            runs.push(run);
        }
    }
    return runs.sort((a, b) => a.id - b.id);
}

// Cluster the given runs' findings and persist the partition. Undefined when
// there are no findings — a judge call over nothing is not a consolidation.
export async function consolidateRuns(
    store: ReviewStore,
    target: Target,
    runs: Run[],
    opts: ClusteringOptions = {},
): Promise<Consolidation | undefined>
{
    const findings: Finding[] = runs.flatMap(run => store.getFindings(run.id));
    if (findings.length === 0)
    {
        return undefined;
    }

    const { clusters: proposals, costUsd } = await runClustering(findings, opts);
    // From here the judge has billed: a throw below (a save that fails, a
    // read-back that doesn't) must carry the meter out with it, or a
    // successful clustering whose persistence failed loses its cost with
    // nothing to show for it (rev 23).
    try
    {
        const byId = new Map(findings.map(f => [f.id, f]));
        const id = store.saveConsolidation({
            owner: target.owner,
            repo: target.repo,
            head: target.head,
            base: target.base,
            runIds: runs.map(run => run.id),
            costUsd,
            clusters: proposals.map((proposal) =>
            {
                const members = proposal.memberIds.map(memberId => byId.get(memberId)!);
                return {
                    memberIds: proposal.memberIds,
                    representativeId: proposal.representativeId,
                    severity: maxSeverity(members.map(m => m.severity)),
                    occurrence: distinctRuns(members),
                };
            }),
        });

        // Read back rather than trust the in-memory proposal: the stored rows
        // are what every later step (coverage, verification, the report) sees.
        return store.getConsolidation(id)!;
    }
    catch (error)
    {
        throw new ClusteringError(error instanceof Error ? error.message : String(error), costUsd);
    }
}
