// Server entry point: wire the stores, the worker, and the HTTP surface
// together and listen. Localhost only — exposing this is the trigger slice's
// decision, not a default. Credit is asserted before listening: a server
// that would bill pay-as-you-go on its first job should not start at all.

import { GitHubClient } from '../github/github.js';
import { assertSubscriptionCredit } from '../review/review.js';
import { JobStore } from '../server/jobs.js';
import { createServer } from '../server/server.js';
import { Worker } from '../server/worker.js';
import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';

const USAGE = 'Usage: npm run serve [-- --port N]';
const DEFAULT_PORT = 4780;
const HOST = '127.0.0.1';

function parsePort(argv: string[]): number
{
    const flag = argv.indexOf('--port');
    if (flag === -1)
    {
        return DEFAULT_PORT;
    }
    const port = Number(argv[flag + 1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
    {
        throw new Error(`--port needs a value between 1 and 65535.\n${USAGE}`);
    }
    return port;
}

function main(): void
{
    assertSubscriptionCredit();
    const port = parsePort(process.argv.slice(2));
    const model = process.env.REVIEW_MODEL ?? 'claude-opus-5';

    const jobs = new JobStore(DEFAULT_DB_PATH);
    const store = new ReviewStore(DEFAULT_DB_PATH);

    for (const id of jobs.recoverInterrupted())
    {
        console.error(`job #${id} was running when the server last stopped; marked failed — re-enqueue to re-run (bills credit)`);
    }

    const worker = new Worker({
        jobs,
        store,
        clientFor: (owner, repo) => new GitHubClient(owner, repo, process.env.GITHUB_TOKEN),
        defaultModel: model,
        onEvent: (id, event) =>
        {
            console.log(`  job #${id}: ${event}`);
        },
    });

    // A drain rejection is a worker bug, not a job failure (those are caught
    // and recorded per job) — log it and keep serving reads.
    const kick = (): void =>
    {
        worker.notify().catch((error: unknown) =>
        {
            console.error(`worker crashed: ${error instanceof Error ? error.message : String(error)}`);
        });
    };

    const server = createServer({ jobs, onEnqueued: kick });
    server.listen(port, HOST, () =>
    {
        console.log(`branch-reviewer serving on http://${HOST}:${port} (model ${model}, db ${DEFAULT_DB_PATH})`);
    });

    // Jobs queued before a restart are still owed a run.
    kick();
}

main();
