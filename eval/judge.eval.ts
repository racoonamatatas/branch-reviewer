// Run-on-demand eval for the clustering judge — NOT part of the unit suite,
// because the judge is stochastic. Replays the frozen golden set through
// runClustering and scores each partition against the human-verified answer.
// One trial is a coin flip dressed as a verdict; --trials N buys a pass rate
// and pair-level precision/recall instead, which is what a prompt edit
// actually changes. Every trial bills a real judge call. A sub-perfect rate
// is a signal to inspect, not a hard fact.

import { existsSync, readFileSync } from 'node:fs';
import { requirePositiveInt, runMain } from '../src/cli/main.js';
import { runClustering } from '../src/consolidate/consolidate.js';
import type { Finding } from '../src/store/store.js';
import { findingId, runId } from '../src/types/ids.js';
import { FIXTURE_PATH } from './fixture.js';

const USAGE = 'Usage: npm run eval:judge [-- --trials N]';

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

interface TrialScore
{
    exact: boolean;
    precision: number;  // of the pairs the judge joined, how many belong together
    recall: number;     // of the pairs that belong together, how many the judge joined
    clusters: number;
    costUsd: number;
    missed: string[];
    falselyLumped: string[];
}

async function runTrial(findings: Finding[], expected: number[][]): Promise<TrialScore>
{
    const { clusters, costUsd } = await runClustering(findings, {
        // The eval must not silently score the fallback as if the judge
        // produced it — a degraded partition is itself the failure.
        onDegraded: violation => console.error(`  clustering degraded: ${violation} — scoring the identity fallback`),
    });
    const actual = clusters.map(c => c.memberIds);

    const expectedPairs = pairs(expected);
    const actualPairs = pairs(actual);
    const shared = [...actualPairs].filter(p => expectedPairs.has(p)).length;
    return {
        exact: canonical(actual).join('|') === canonical(expected).join('|'),
        // An empty pair set divides by zero: a judge that joined nothing has
        // perfect precision, a golden set with no pairs is perfectly recalled.
        precision: actualPairs.size === 0 ? 1 : shared / actualPairs.size,
        recall: expectedPairs.size === 0 ? 1 : shared / expectedPairs.size,
        clusters: actual.length,
        costUsd,
        missed: [...expectedPairs].filter(p => !actualPairs.has(p)),
        falselyLumped: [...actualPairs].filter(p => !expectedPairs.has(p)),
    };
}

function parseTrials(argv: string[]): number
{
    for (let i = 0; i < argv.length; i++)
    {
        if (argv[i] === '--trials')
        {
            return requirePositiveInt(argv[i + 1], '--trials', USAGE);
        }
    }
    return 1;
}

async function main(): Promise<number>
{
    const trials = parseTrials(process.argv.slice(2));

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
    console.log(`Clustering ${fixture.findings.length} findings, ${trials} trial(s)...`);

    const findings: Finding[] = fixture.findings.map(f =>
        ({ ...f, id: findingId(f.id), runId: runId(f.runId) }));

    // Sequential on purpose: identical back-to-back judge calls ride the
    // prompt cache, so trial N+1 is cheaper than trial 1.
    const scores: TrialScore[] = [];
    for (let trial = 1; trial <= trials; trial++)
    {
        const score = await runTrial(findings, fixture.expectedClusters);
        scores.push(score);
        if (score.exact)
        {
            console.log(`trial ${trial}/${trials}: PASS — exact match (${score.clusters} clusters), $${score.costUsd.toFixed(4)}`);
            continue;
        }
        console.error(`trial ${trial}/${trials}: FAIL — pair precision ${score.precision.toFixed(2)}, `
            + `recall ${score.recall.toFixed(2)} (${score.clusters} clusters vs ${fixture.expectedClusters.length} expected), `
            + `$${score.costUsd.toFixed(4)}`);
        for (const pair of score.missed)
        {
            console.error(`  split apart (should be together): findings ${pair}`);
        }
        for (const pair of score.falselyLumped)
        {
            console.error(`  lumped together (should be apart): findings ${pair}`);
        }
    }

    const passed = scores.filter(s => s.exact).length;
    const mean = (of: (s: TrialScore) => number): number => scores.reduce((sum, s) => sum + of(s), 0) / scores.length;
    const totalCost = scores.reduce((sum, s) => sum + s.costUsd, 0);
    console.log(`\npass rate ${passed}/${trials}`
        + `, mean pair precision ${mean(s => s.precision).toFixed(2)}`
        + `, mean recall ${mean(s => s.recall).toFixed(2)}`
        + `, total judge cost $${totalCost.toFixed(4)}`);

    if (passed === trials)
    {
        return 0;
    }
    console.error('The judge is stochastic — a sub-perfect rate is a signal to inspect the pair diffs above, not a hard fact.');
    return 1;
}

runMain(main);
