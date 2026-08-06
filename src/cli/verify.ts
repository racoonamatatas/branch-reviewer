// Verification entry point: adjudicate a consolidation's pending occurrence-1
// clusters, one adversarial query() each. Each verdict is saved as it lands
// (append-only; a failed cluster stays pending and a re-run picks it up),
// then the report is re-rendered by reading back — the output is the
// round-trip, never a parallel code path.

import { GitHubClient } from '../github/github.js';
import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';
import type { Cluster, Consolidation } from '../store/store.js';
import { consolidationId } from '../types/ids.js';
import { pendingOccurrenceOne, verifyCluster } from '../verify/verify.js';
import { printConsolidation } from './render.js';

const USAGE = 'Usage: npm run verify -- <consolidation-id> [--max-turns N]';

async function main(): Promise<number>
{
    const args = process.argv.slice(2);
    const positional: string[] = [];
    let maxTurns: number | undefined;
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

        const pending = pendingOccurrenceOne(consolidation.clusters);
        if (pending.length === 0)
        {
            console.log(`No pending occurrence-1 clusters in consolidation #${id}.`);
            printConsolidation(consolidation);
            return 0;
        }

        const failures = await verifyAll(store, consolidation, pending, maxTurns);

        printConsolidation(store.getConsolidation(id)!);
        return failures > 0 ? 2 : 0;
    }
    finally
    {
        store.close();
    }
}

async function verifyAll(store: ReviewStore, consolidation: Consolidation, pending: Cluster[], maxTurns?: number): Promise<number>
{
    const model = process.env.REVIEW_MODEL ?? 'claude-opus-5';
    const github = new GitHubClient(consolidation.owner, consolidation.repo, process.env.GITHUB_TOKEN);
    const target = { base: consolidation.base, head: consolidation.head };
    const totalRuns = consolidation.runIds.length;

    console.log(`Verifying ${pending.length} occurrence-1 finding(s) from consolidation #${consolidation.id} `
        + `against "${consolidation.head}" vs "${consolidation.base}" with ${model}`);

    let failures = 0;
    let totalCost = 0;
    for (const cluster of pending)
    {
        const f = cluster.representative;
        console.log(`\n--- cluster #${cluster.id}: [${cluster.severity}] ${f.file} — ${f.title}`);
        try
        {
            const result = await verifyCluster(github, target, cluster, totalRuns, {
                model,
                ...(maxTurns !== undefined ? { maxTurns } : {}),
                onProgress: (event) =>
                {
                    console.log(`  ${event}`);
                },
            });
            totalCost += result.stats.costUsd;

            if (result.status === 'aborted')
            {
                console.error(`  verification aborted: ${result.reason} — cluster stays pending`);
                failures++;
                continue;
            }

            const { verdict, rationale, confidence } = result.response;
            store.saveVerification({ clusterId: cluster.id, verdict, rationale, confidence, costUsd: result.stats.costUsd });
            console.log(`  verdict: ${verdict} ($${result.stats.costUsd.toFixed(4)}, ${result.stats.turns} turn(s))`);
            console.log(`  rationale: ${rationale}`);
            console.log(`  confidence: ${confidence}`);
        }
        catch (error)
        {
            console.error(`  verification failed: ${error instanceof Error ? error.message : String(error)} — cluster stays pending`);
            failures++;
        }
    }

    console.log(`\nverified ${pending.length - failures}/${pending.length} cluster(s), total cost $${totalCost.toFixed(4)}`);
    return failures;
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
