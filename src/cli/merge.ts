// Cross-run merge entry point: cluster the findings of stored runs into one
// merged report. Saves first, renders by reading back — the output is the
// round-trip, never a parallel code path.

import { distinctRuns, maxSeverity, runClustering } from '../merge/merge.js';
import type { MergeableFinding } from '../merge/merge.js';
import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';
import type { StoredRun } from '../store/store.js';
import { printMerge } from './render.js';

const USAGE = 'Usage: npm run merge -- <run-id> <run-id> [...] | npm run merge | npm run merge -- --show <merge-id>';

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
        return await merge(store, runIds);
    }
    finally
    {
        store.close();
    }
}

function list(store: ReviewStore): number
{
    const merges = store.listMerges();
    if (merges.length === 0)
    {
        console.log('No stored merges.');
        return 0;
    }
    for (const m of merges)
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
    const merge = store.getMerge(id);
    if (merge === undefined)
    {
        console.error(`No merge #${id}.`);
        return 1;
    }
    printMerge(merge);
    return 0;
}

async function merge(store: ReviewStore, runIds: number[]): Promise<number>
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
            throw new Error(`Run #${id} has no review (status: ${run.status}) — merge submitted runs only.`);
        }
        runs.push(run);
    }

    const first = runs[0]!;
    for (const run of runs)
    {
        if (run.owner !== first.owner || run.repo !== first.repo || run.head !== first.head || run.base !== first.base)
        {
            throw new Error(`Run #${run.id} targets a different branch than run #${first.id} — merge runs of one target only.`);
        }
    }

    const findings: MergeableFinding[] = runIds.flatMap(id => store.getFindings(id));
    if (findings.length === 0)
    {
        throw new Error('The selected runs have no findings to merge.');
    }

    console.log(`Clustering ${findings.length} findings from ${runs.length} runs...`);
    const clusters = await runClustering(findings, { model: process.env.REVIEW_MODEL });

    const byId = new Map(findings.map(f => [f.id, f]));
    const mergeId = store.saveMerge({
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
    console.log(`saved as merge #${mergeId}`);

    printMerge(store.getMerge(mergeId)!);
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
