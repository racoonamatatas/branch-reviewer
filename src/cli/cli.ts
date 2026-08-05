// Thin shell: arg parsing, wiring, rendering, exit codes. Ported from
// branch-reviewer-api with --max-iterations renamed to --max-turns (the
// SDK's unit) and a cost line added to the stats output.

import { GitHubClient } from '../github/github.js';
import { runReview } from '../review/review.js';
import type { Review, Severity } from '../schema/schema.js';

const USAGE = 'Usage: npm run review -- <owner>/<repo> <branch> [--base main] [--max-turns N]';

interface CliArgs
{
    owner: string;
    repo: string;
    head: string;
    base: string;
    maxTurns?: number;
}

function parseArgs(argv: string[]): CliArgs
{
    const positional: string[] = [];
    let base = 'main';
    let maxTurns: number | undefined;

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
    return { owner, repo, head, base, maxTurns };
}

function requireValue(value: string | undefined, flag: string): string
{
    if (value === undefined)
    {
        throw new Error(`${flag} needs a value.\n${USAGE}`);
    }
    return value;
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

    const { stats } = result;
    console.log(`\ntokens: ${stats.usage.inputTokens} in / ${stats.usage.outputTokens} out, `
        + `${stats.turns} turn(s), $${stats.costUsd.toFixed(4)} (reported; subscription runs are not billed per-token)`);

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
