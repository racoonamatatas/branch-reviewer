// Thin shell: arg parsing, wiring, rendering, exit codes. Ported from
// branch-reviewer-api with --max-iterations renamed to --max-turns (the
// SDK's unit) and a cost line added to the stats output.

import { GitHubClient } from '../github/github.js';
import { runReview } from '../review/review.js';
import type { ReviewRunStats } from '../review/review.js';
import type { Review, Severity } from '../schema/schema.js';
import { diffUsage, isZeroUsage } from '../usage/usage.js';
import type { TokenUsage } from '../usage/usage.js';

const USAGE = 'Usage: npm run review -- <owner>/<repo> <branch> [--base main] [--max-turns N] [--verbose]';

interface CliArgs
{
    owner: string;
    repo: string;
    head: string;
    base: string;
    maxTurns?: number;
    verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs
{
    const positional: string[] = [];
    let base = 'main';
    let maxTurns: number | undefined;
    let verbose = false;

    for (let i = 0; i < argv.length; i++)
    {
        const arg = argv[i]!;
        if (arg === '--base')
        {
            base = requireValue(argv[++i], arg);
        }
        else if (arg === '--max-turns')
        {
            maxTurns = Number(requireValue(argv[++i], arg));
        }
        else if (arg === '--verbose')
        {
            verbose = true;
        }
        else
        {
            positional.push(arg);
        }
    }

    const [repoSpec, head] = positional;
    const [owner, repo] = (repoSpec ?? '').split('/');
    if (owner === undefined || owner === '' || repo === undefined || repo === '' || head === undefined)
    {
        throw new Error(USAGE);
    }
    return { owner, repo, head, base, maxTurns, verbose };
}

function requireValue(value: string | undefined, flag: string): string
{
    if (value === undefined)
    {
        throw new Error(`${flag} needs a value.\n${USAGE}`);
    }
    return value;
}

function n(value: number): string
{
    return value.toLocaleString('en-US');
}

function usageLine(usage: TokenUsage): string
{
    return `${n(usage.inputTokens)} fresh + ${n(usage.cacheReadInputTokens)} cache-read`
        + ` + ${n(usage.cacheCreationInputTokens)} cache-write in / ${n(usage.outputTokens)} out`;
}

function printStats(stats: ReviewRunStats, verbose: boolean): void
{
    console.log(`\ntokens: ${usageLine(stats.usage)}, ${stats.turns} turn(s), `
        + `$${stats.costUsd.toFixed(4)} (reported; subscription runs are not billed per-token)`);

    for (const [model, m] of Object.entries(stats.perModel))
    {
        console.log(`  ${model}: ${n(m.inputTokens)} fresh + ${n(m.cacheReadInputTokens)} cache-read`
            + ` + ${n(m.cacheCreationInputTokens)} cache-write in / ${n(m.outputTokens)} out,`
            + ` $${m.costUSD.toFixed(4)}, context window ${n(m.contextWindow)}`);
    }

    // Observational reconciliation: our streamed sum vs the SDK's totals.
    // A delta is information about what the SDK counts that the stream does
    // not show — it never affects the review or the exit code.
    const delta = diffUsage(stats.usage, stats.streamed);
    if (!isZeroUsage(delta))
    {
        console.log(`  warning: SDK totals differ from streamed sum by ${usageLine(delta)}`);
    }

    if (verbose)
    {
        console.log('\nper-turn usage (streamed, deduped by message id):');
        for (const turn of stats.turnUsage)
        {
            console.log(`  ${turn.messageId}  ${usageLine(turn.usage)}`);
        }
    }
}

function printReview(review: Review): void
{
    console.log(`\n${review.summary}\n`);
    if (review.findings.length === 0)
    {
        console.log('No findings.');
        return;
    }
    const order: Severity[] = ['critical', 'warning', 'nit'];
    for (const severity of order)
    {
        for (const f of review.findings.filter(x => x.severity === severity))
        {
            const line = f.line !== undefined ? `:${f.line}` : '';
            console.log(`[${f.severity}] ${f.file}${line} — ${f.title}`);
            console.log(`    ${f.detail}`);
            if (f.suggestion !== undefined)
            {
                console.log(`    suggestion: ${f.suggestion}`);
            }
            console.log('');
        }
    }
}

async function main(): Promise<number>
{
    const args = parseArgs(process.argv.slice(2));
    const model = process.env.REVIEW_MODEL ?? 'claude-opus-5';
    const github = new GitHubClient(args.owner, args.repo, process.env.GITHUB_TOKEN);

    console.log(`Reviewing ${args.owner}/${args.repo} "${args.head}" against "${args.base}" with ${model}\n`);

    const result = await runReview(github, { base: args.base, head: args.head }, {
        model,
        maxTurns: args.maxTurns,
        onProgress: (event) =>
        {
            console.log(`  ${event}`);
        },
    });

    printStats(result.stats, args.verbose);

    if (result.status === 'aborted')
    {
        console.error(`Review aborted: ${result.reason}`);
        return 2;
    }

    printReview(result.review);
    return result.review.findings.some(f => f.severity === 'critical') ? 1 : 0;
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
