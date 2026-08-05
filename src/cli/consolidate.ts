// Cross-run consolidation entry point: cluster the findings of stored runs into one
// consolidated report. Saves first, renders by reading back — the output is the
// round-trip, never a parallel code path.

import { distinctRuns, maxSeverity, runClustering } from '../consolidate/consolidate.js';
import type { ConsolidatableFinding } from '../consolidate/consolidate.js';
import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';
import type { StoredRun } from '../store/store.js';
import { printConsolidation } from './render.js';

const USAGE = 'Usage: npm run consolidate -- <run-id> <run-id> [...] | npm run consolidate | npm run consolidate -- --show <consolidation-id>';

async function main(): Promise<number>
{
    const args = process.argv.slice(2);
    const store = new ReviewStore(DEFAULT_DB_PATH);
    try
    {
        if (args.length === 0)
        {
            return list(store);
        }
        if (args[0] === '--show')
        {
            return show(store, Number(args[1]));
        }
        const runIds = args.map(Number);
        if (runIds.length < 2 || runIds.some(id => !Number.isInteger(id)))
        {
            throw new Error(USAGE);
        }
        return await consolidate(store, runIds);
    }
    finally
    {
        store.close();
    }
}

function list(store: ReviewStore): number
{
    const consolidations = store.listConsolidations();
    if (consolidations.length === 0)
    {
        console.log('No stored consolidations.');
        return 0;
    }
    for (const m of consolidations)
    {
        console.log(`#${m.id}  ${m.createdAt}  ${m.target}  runs [${m.runIds.join(', ')}]  ${m.clusterCount} cluster(s)`);
    }
    return 0;
}

function show(store: ReviewStore, id: number): number
{
    if (!Number.isInteger(id))
    {
        throw new Error(USAGE);
    }
    const consolidation = store.getConsolidation(id);
    if (consolidation === undefined)
    {
        console.error(`No consolidation #${id}.`);
        return 1;
    }
    printConsolidation(consolidation);
    return 0;
}

async function consolidate(store: ReviewStore, runIds: number[]): Promise<number>
{
    const runs: StoredRun[] = [];
    for (const id of runIds)
    {
        const run = store.getRun(id);
        if (run === undefined)
        {
            throw new Error(`No run #${id}.`);
        }
        if (run.review === undefined)
        {
            throw new Error(`Run #${id} has no review (status: ${run.status}) — consolidate submitted runs only.`);
        }
        runs.push(run);
    }

    const first = runs[0]!;
    for (const run of runs)
    {
        if (run.owner !== first.owner || run.repo !== first.repo || run.head !== first.head || run.base !== first.base)
        {
            throw new Error(`Run #${run.id} targets a different branch than run #${first.id} — consolidate runs of one target only.`);
        }
    }

    const findings: ConsolidatableFinding[] = runIds.flatMap(id => store.getFindings(id));
    if (findings.length === 0)
    {
        throw new Error('The selected runs have no findings to consolidate.');
    }

    console.log(`Clustering ${findings.length} findings from ${runs.length} runs...`);
    const clusters = await runClustering(findings, { model: process.env.REVIEW_MODEL });

    const byId = new Map(findings.map(f => [f.id, f]));
    const consolidationId = store.saveConsolidation({
        createdAt: new Date().toISOString(),
        owner: first.owner,
        repo: first.repo,
        head: first.head,
        base: first.base,
        runIds,
        clusters: clusters.map((cluster) =>
        {
            const members = cluster.memberIds.map(id => byId.get(id)!);
            return {
                memberIds: cluster.memberIds,
                representativeId: cluster.representativeId,
                severity: maxSeverity(members.map(m => m.severity)),
                occurrence: distinctRuns(members),
            };
        }),
    });
    console.log(`saved as consolidation #${consolidationId}`);

    printConsolidation(store.getConsolidation(consolidationId)!);
    return 0;
}

main().then(
    (code) =>
    {
        process.exitCode = code;
    },
    (err: unknown) =>
    {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
    },
);
