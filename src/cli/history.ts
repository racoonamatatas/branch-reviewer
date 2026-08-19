// Read-back for stored runs: a list, or one run in full.
// Streamed/per-turn detail is not persisted; a shown run prints its stored
// totals only.

import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';
import { runId } from '../types/ids.js';
import type { RunId } from '../types/ids.js';
import { n, printReview, usageLine } from './render.js';

const USAGE = 'Usage: npm run history [-- <run-id>]';

function main(): number
{
    const args = process.argv.slice(2);
    const store = new ReviewStore(DEFAULT_DB_PATH);
    try
    {
        if (args.length === 0)
        {
            return list(store);
        }
        const raw = Number(args[0]);
        if (!Number.isInteger(raw))
        {
            throw new Error(USAGE);
        }
        return show(store, runId(raw));
    }
    finally
    {
        store.close();
    }
}

function list(store: ReviewStore): number
{
    const runs = store.listRuns();
    if (runs.length === 0)
    {
        console.log('No stored runs.');
        return 0;
    }
    for (const run of runs)
    {
        console.log(`#${run.id}  ${run.createdAt}  ${run.target}  ${run.status}`
            + `  ${n(run.findingsCount)} finding(s)  $${run.costUsd.toFixed(4)}`);
    }
    return 0;
}

function show(store: ReviewStore, id: RunId): number
{
    const run = store.getRun(id);
    if (run === undefined)
    {
        console.error(`No run #${id}.`);
        return 1;
    }

    console.log(`run #${run.id}  ${run.createdAt}  ${run.owner}/${run.repo} "${run.head}" against "${run.base}"  ${run.model}`);
    console.log(`tokens: ${usageLine(run.usage)}, ${run.turns} turn(s), $${run.costUsd.toFixed(4)}`);

    if (run.status === 'aborted')
    {
        console.log(`aborted: ${run.reason ?? 'unknown'}`);
        return 0;
    }
    if (run.status === 'empty')
    {
        console.log('empty diff: the compare listed no changed files — nothing was reviewed');
        return 0;
    }
    if (run.review !== undefined)
    {
        printReview(run.review);
    }
    return 0;
}

try
{
    process.exitCode = main();
}
catch (err)
{
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
}
