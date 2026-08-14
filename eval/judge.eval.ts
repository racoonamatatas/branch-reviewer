// Run-on-demand eval for the clustering judge — NOT part of the unit suite,
// because the judge is stochastic. Replays the frozen golden set through
// runClustering and scores the partition against the human-verified answer.
// A fail is a signal to inspect (and possibly rerun), not a hard fact; a
// pass after a prompt edit is the difference between "we improved the
// prompt" and "we think we improved the prompt".

import { existsSync, readFileSync } from 'node:fs';
import { runMain } from '../src/cli/main.js';
import { runClustering } from '../src/consolidate/consolidate.js';
import type { Finding } from '../src/store/store.js';
import { findingId, runId } from '../src/types/ids.js';
import { FIXTURE_PATH } from './fixture.js';

// The fixture file is wire-shaped: plain-number ids that gain their brand at load.
interface Fixture
{
    description: string;
    findings: Array<Omit<Finding, 'id' | 'runId'> & { id: number; runId: number }>;
    expectedClusters: number[][];
}

function canonical(groups: number[][]): string[]
{
    return groups
        .map(g => [...g].sort((a, b) => a - b).join(','))
        .sort();
}

// Every unordered pair of ids that shares a group.
function pairs(groups: number[][]): Set<string>
{
    const result = new Set<string>();
    for (const group of groups)
    {
        for (let i = 0; i < group.length; i++)
        {
            for (let j = i + 1; j < group.length; j++)
            {
                const [a, b] = [group[i]!, group[j]!].sort((x, y) => x - y);
                result.add(`${a}+${b}`);
            }
        }
    }
    return result;
}

async function main(): Promise<number>
{
    // The fixture is gitignored (finding text contains repo internals), so a
    // fresh clone has none — that is a setup state, not a crash.
    if (!existsSync(FIXTURE_PATH))
    {
        console.error(`No golden fixture at ${FIXTURE_PATH}.`);
        console.error('Freeze a human-verified consolidation first: npm run eval:freeze -- <consolidation-id>');
        return 1;
    }
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
    console.log(fixture.description);
    console.log(`Clustering ${fixture.findings.length} findings...`);

    const findings: Finding[] = fixture.findings.map(f =>
        ({ ...f, id: findingId(f.id), runId: runId(f.runId) }));
    const { clusters, costUsd } = await runClustering(findings, {
        // The eval must not silently score the fallback as if the judge
        // produced it — a degraded partition is itself the failure.
        onDegraded: violation => console.error(`clustering degraded: ${violation} — scoring the identity fallback`),
    });
    console.log(`judge cost: $${costUsd.toFixed(4)}`);
    const actual = clusters.map(c => c.memberIds);

    if (canonical(actual).join('|') === canonical(fixture.expectedClusters).join('|'))
    {
        console.log(`PASS — partition matches the golden set exactly (${actual.length} clusters).`);
        return 0;
    }

    const expectedPairs = pairs(fixture.expectedClusters);
    const actualPairs = pairs(actual);
    const missed = [...expectedPairs].filter(p => !actualPairs.has(p));
    const falselyLumped = [...actualPairs].filter(p => !expectedPairs.has(p));

    console.error(`FAIL — partition differs from the golden set (${actual.length} clusters vs ${fixture.expectedClusters.length} expected).`);
    for (const pair of missed)
    {
        console.error(`  split apart (should be together): findings ${pair}`);
    }
    for (const pair of falselyLumped)
    {
        console.error(`  lumped together (should be apart): findings ${pair}`);
    }
    console.error('The judge is stochastic — inspect the diffs above; rerun before concluding a regression.');
    return 1;
}

runMain(main);
