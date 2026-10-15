// Thin shell: arg parsing, wiring, persistence, exit codes. Rendering lives
// in render.ts, shared with the history entry point.

import { GitHubClient } from '../github/github.js';
import { runReview } from '../review/review.js';
import type { ReviewResult } from '../review/review.js';
import { reviewModel } from '../sdk/models.js';
import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';
import { requirePositiveInt, requireValue, runMain } from './main.js';
import { printReview, printStats } from './render.js';

const USAGE = 'Usage: npm run review -- <owner>/<repo> <branch> [--base main] [--max-turns N] [--verbose] [--no-save]';

interface CliArgs
{
    owner: string;
    repo: string;
    head: string;
    base: string;
    maxTurns?: number;
    verbose: boolean;
    save: boolean;
}

function parseArgs(argv: string[]): CliArgs
{
    const positional: string[] = [];
    let base = 'main';
    let maxTurns: number | undefined;
    let verbose = false;
    let save = true;

    for (let i = 0; i < argv.length; i++)
    {
        const arg = argv[i]!;
        if (arg === '--base')
        {
            base = requireValue(argv[++i], arg, USAGE);
        }
        else if (arg === '--max-turns')
        {
            maxTurns = requirePositiveInt(argv[++i], arg, USAGE);
        }
        else if (arg === '--verbose')
        {
            verbose = true;
        }
        else if (arg === '--no-save')
        {
            save = false;
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
    return { owner, repo, head, base, maxTurns, verbose, save };
}

// Persistence is observational, like the accounting: a failed save warns
// and moves on, it never changes the review's outcome or exit code.
function saveRun(args: CliArgs, model: string, result: ReviewResult): void
{
    try
    {
        const store = new ReviewStore(DEFAULT_DB_PATH);
        const id = store.saveRun({
            owner: args.owner,
            repo: args.repo,
            head: args.head,
            base: args.base,
            model,
            status: result.status,
            ...(result.status === 'aborted' ? { reason: result.reason } : {}),
            ...(result.status === 'submitted' ? { review: result.review } : {}),
            turns: result.stats.turns,
            costUsd: result.stats.costUsd,
            usage: result.stats.usage,
            filesChanged: result.filesChanged,
        });
        store.close();
        console.log(`saved as run #${id}`);
    }
    catch (error)
    {
        console.error(`warning: could not save run: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function main(): Promise<number>
{
    const args = parseArgs(process.argv.slice(2));
    const model = reviewModel();
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

    if (args.save)
    {
        saveRun(args, model, result);
    }

    if (result.status === 'aborted')
    {
        console.error(`Review aborted: ${result.reason}`);
        return 2;
    }

    // Clean exit, worded as the observation: an omitted `files` key in the
    // compare payload also lands here, so this must not assert the branch
    // itself is empty.
    if (result.status === 'empty')
    {
        console.log('Empty diff: the compare listed no changed files — nothing was reviewed, no credit spent.');
        return 0;
    }

    printReview(result.review);
    return result.review.findings.some(f => f.severity === 'critical') ? 1 : 0;
}

runMain(main);
