// Verification entry point: adjudicate a consolidation's pending occurrence-1
// clusters, one adversarial query() each. The loop itself lives in
// src/verify/verify.ts (the campaign runs it too); this file is arg parsing
// and rendering. The report is re-rendered by reading back — the output is
// the round-trip, never a parallel code path.

import { GitHubClient } from '../github/github.js';
import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';
import { consolidationId } from '../types/ids.js';
import { verifyPending } from '../verify/verify.js';
import { printConsolidation, printVerdictProgress } from './render.js';

const USAGE = 'Usage: npm run verify -- <consolidation-id> [--max-turns N] [--reverify]';

async function main(): Promise<number>
{
    const args = process.argv.slice(2);
    const positional: string[] = [];
    let maxTurns: number | undefined;
    let reverify = false;
    for (let i = 0; i < args.length; i++)
    {
        const arg = args[i]!;
        if (arg === '--max-turns')
        {
            const value = args[++i];
            if (value === undefined)
            {
                throw new Error(`--max-turns needs a value.\n${USAGE}`);
            }
            maxTurns = Number(value);
        }
        else if (arg === '--reverify')
        {
            reverify = true;
        }
        else
        {
            positional.push(arg);
        }
    }

    const raw = Number(positional[0]);
    if (positional.length !== 1 || !Number.isInteger(raw))
    {
        throw new Error(USAGE);
    }
    const id = consolidationId(raw);

    const store = new ReviewStore(DEFAULT_DB_PATH);
    try
    {
        const consolidation = store.getConsolidation(id);
        if (consolidation === undefined)
        {
            console.error(`No consolidation #${id}.`);
            return 1;
        }

        const model = process.env.REVIEW_MODEL ?? 'claude-opus-5';
        const github = new GitHubClient(consolidation.owner, consolidation.repo, process.env.GITHUB_TOKEN);

        const summary = await verifyPending(store, github, consolidation, {
            model,
            reverify,
            ...(maxTurns !== undefined ? { maxTurns } : {}),
            ...printVerdictProgress(),
        });

        if (summary.attempted === 0)
        {
            console.log(`No occurrence-1 clusters awaiting a verdict in consolidation #${id}`
                + `${reverify ? '' : ' (--reverify re-tests settled ones)'}.`);
        }
        else
        {
            console.log(`\nverified ${summary.verified}/${summary.attempted} cluster(s), `
                + `total cost $${summary.costUsd.toFixed(4)}`);
        }

        printConsolidation(store.getConsolidation(id)!);
        return summary.failures > 0 ? 2 : 0;
    }
    finally
    {
        store.close();
    }
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
