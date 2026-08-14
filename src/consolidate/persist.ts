// Store-aware consolidation: cluster a target's stored findings and persist
// the partition. Shared by the campaign loop and the verify job — policy
// (how many runs are enough, when to re-consolidate) stays with the caller;
// this module owns the mechanics of findings → judge → validated partition
// → rows.

import { distinctRuns, maxSeverity, runClustering } from './consolidate.js';
import type { ClusteringOptions } from './consolidate.js';
import type { Consolidation, Finding, ReviewStore, Run } from '../store/store.js';

export interface ConsolidationTarget
{
    owner: string;
    repo: string;
    head: string;
    base: string;
}

// Every stored submitted run of this target, oldest first — the round order
// a campaign would have produced. The quad filter (base included) is pushed
// into the store: a campaign re-reads this on every round, and pulling the
// whole runs table to filter in JS grew with the database, not the target.
export function submittedRunsFor(store: ReviewStore, target: ConsolidationTarget): Run[]
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
    target: ConsolidationTarget,
    runs: Run[],
    opts: ClusteringOptions = {},
): Promise<Consolidation | undefined>
{
    const findings: Finding[] = runs.flatMap(run => store.getFindings(run.id));
    if (findings.length === 0)
    {
        return undefined;
    }

    const proposals = await runClustering(findings, opts);
    const byId = new Map(findings.map(f => [f.id, f]));
    const id = store.saveConsolidation({
        owner: target.owner,
        repo: target.repo,
        head: target.head,
        base: target.base,
        runIds: runs.map(run => run.id),
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

    // Read back rather than trust the in-memory proposal: the stored rows are
    // what every later step (coverage, verification, the report) sees.
    return store.getConsolidation(id)!;
}
