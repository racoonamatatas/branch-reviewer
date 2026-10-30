// Verification entry point: adjudicate a consolidation's pending occurrence-1
// clusters, one adversarial query() each. The loop itself lives in
// src/verify/verify.ts (the campaign runs it too); this file is arg parsing
// and rendering. The report is re-rendered by reading back — the output is
// the round-trip, never a parallel code path.

import { GitHubClient } from '../github/github.js';
import { verifyModels } from '../sdk/models.js';
import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';
import { consolidationId } from '../types/ids.js';
import { verifyPending } from '../verify/verify.js';
import { requirePositiveInt, runMain } from './main.js';
import { printConsolidation, printVerdictProgress } from './render.js';

const USAGE = 'Usage: npm run verify -- <consolidation-id> [--max-turns N] [--reverify] [--verify-all]';

async function main(): Promise<number>
{
    const args = process.argv.slice(2);
    const positional: string[] = [];
    let maxTurns: number | undefined;
    let reverify = false;
    let verifyAll = false;
    for (let i = 0; i < args.length; i++)
    {
        const arg = args[i]!;
        if (arg === '--max-turns')
        {
            maxTurns = requirePositiveInt(args[++i], arg, USAGE);
        }
        else if (arg === '--reverify')
        {
            reverify = true;
        }
        else if (arg === '--verify-all')
        {
            verifyAll = true;
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

        const models = verifyModels();
        const github = new GitHubClient(consolidation.owner, consolidation.repo, process.env.GITHUB_TOKEN);

        const summary = await verifyPending(store, github, consolidation, {
            models,
            reverify,
            verifyAll,
            ...(maxTurns !== undefined ? { maxTurns } : {}),
            ...printVerdictProgress(),
        });

        if (summary.attempted === 0)
        {
            const hints = [
                ...(verifyAll ? [] : ['--verify-all queues corroborated clusters too']),
                ...(reverify ? [] : ['--reverify re-tests settled ones']),
            ];
            console.log(`No clusters awaiting a verdict in consolidation #${id}`
                + (hints.length > 0 ? ` (${hints.join('; ')})` : '') + '.');
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

runMain(main);
