// Server entry point: wire the stores, the worker, the trigger, and the HTTP
// surface together and listen. Localhost only — exposing this is a deploy
// decision, not a default. Credit is asserted before listening: a server
// that would bill pay-as-you-go on its first job should not start at all.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubClient } from '../github/github.js';
import { assertSubscriptionCredit } from '../review/review.js';
import { EventLog } from '../server/events.js';
import { JobStore } from '../server/jobs.js';
import { createServer } from '../server/server.js';
import { pollOnce, WatchStore } from '../server/trigger.js';
import { Worker } from '../server/worker.js';
import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';

const USAGE = 'Usage: npm run serve [-- --port N] [--poll-interval seconds]';
const DEFAULT_PORT = 4780;
const HOST = '127.0.0.1';
// GitHub costs one request per watch per cycle (5000/h with a token), and a
// labeled push rarely needs a sub-5-minute pickup.
const DEFAULT_POLL_INTERVAL_S = 300;
const MIN_POLL_INTERVAL_S = 10;

// The built dashboard, located relative to this module so the server finds
// it from any working directory. index.html is the tell for "built": serving
// a half-empty dist would look like a broken app, not a missing build.
function dashboardRoot(): string | undefined
{
    const dist = fileURLToPath(new URL('../../dashboard/dist', import.meta.url));
    return existsSync(join(dist, 'index.html')) ? dist : undefined;
}

interface ServeArgs
{
    port: number;
    pollIntervalMs: number;
}

function parseArgs(argv: string[]): ServeArgs
{
    let port = DEFAULT_PORT;
    let pollIntervalS = DEFAULT_POLL_INTERVAL_S;

    for (let i = 0; i < argv.length; i++)
    {
        if (argv[i] === '--port')
        {
            port = Number(argv[++i]);
            if (!Number.isInteger(port) || port < 1 || port > 65535)
            {
                throw new Error(`--port needs a value between 1 and 65535.\n${USAGE}`);
            }
        }
        else if (argv[i] === '--poll-interval')
        {
            pollIntervalS = Number(argv[++i]);
            if (!Number.isInteger(pollIntervalS) || pollIntervalS < MIN_POLL_INTERVAL_S)
            {
                throw new Error(`--poll-interval needs a value of at least ${MIN_POLL_INTERVAL_S} seconds.\n${USAGE}`);
            }
        }
    }
    return { port, pollIntervalMs: pollIntervalS * 1000 };
}

function main(): void
{
    assertSubscriptionCredit();
    const args = parseArgs(process.argv.slice(2));
    const model = process.env.REVIEW_MODEL ?? 'claude-opus-5';

    const jobs = new JobStore(DEFAULT_DB_PATH);
    const store = new ReviewStore(DEFAULT_DB_PATH);
    const watches = new WatchStore(DEFAULT_DB_PATH);

    // Everything the console sees also lands in the activity ring, so the
    // dashboard can answer "is anything actually happening" without a
    // terminal. A liveness feed, not a record — it dies with the process.
    const activityLog = new EventLog();

    for (const id of jobs.recoverInterrupted())
    {
        console.error(`job #${id} was running when the server last stopped; marked failed — re-enqueue to re-run (bills credit)`);
        activityLog.push('server', `job #${id} was running at the last shutdown — marked failed`);
    }

    const worker = new Worker({
        jobs,
        store,
        clientFor: (owner, repo) => new GitHubClient(owner, repo, process.env.GITHUB_TOKEN),
        defaultModel: model,
        onEvent: (id, event) =>
        {
            console.log(`  job #${id}: ${event}`);
            activityLog.push('worker', `job #${id}: ${event}`);
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

    // The trigger: poll on an interval, kick the worker when anything landed.
    // Overlapping passes are skipped rather than queued — two concurrent
    // passes could both see a head SHA as unseen and enqueue it twice.
    let polling = false;
    let lastPollAt: string | undefined;
    const poll = async (): Promise<void> =>
    {
        if (polling)
        {
            return;
        }
        polling = true;
        try
        {
            const report = await pollOnce({
                watches,
                jobs,
                pullSourceFor: (owner, repo) => new GitHubClient(owner, repo, process.env.GITHUB_TOKEN),
                onEvent: (event) =>
                {
                    console.log(`  trigger: ${event}`);
                    activityLog.push('trigger', event);
                },
            });
            for (const error of report.errors)
            {
                console.error(`  trigger: ${error}`);
                activityLog.push('trigger', error);
            }
            if (report.capped > 0)
            {
                console.log(`  trigger: ${report.capped} PR(s) deferred to the next cycle by the per-cycle cap`);
            }
            // One line per cycle even when nothing happened — a quiet pass and
            // a dead poller look identical without it.
            activityLog.push('trigger', `poll pass: ${watches.list().length} watch(es) — `
                + `${report.enqueued.length} enqueued, ${report.skipped} seen before, ${report.capped} deferred`);
            if (report.enqueued.length > 0)
            {
                kick();
            }
        }
        catch (error)
        {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`trigger crashed: ${message}`);
            activityLog.push('trigger', `poll pass crashed: ${message}`);
        }
        finally
        {
            lastPollAt = new Date().toISOString();
            polling = false;
        }
    };

    const staticRoot = dashboardRoot();
    const server = createServer({
        jobs,
        watches,
        store,
        onEnqueued: (id) =>
        {
            activityLog.push('server', `job #${id} enqueued over HTTP`);
            kick();
        },
        activity: {
            log: activityLog,
            poll: () => ({ polling: true, intervalMs: args.pollIntervalMs, ...(lastPollAt !== undefined ? { lastAt: lastPollAt } : {}) }),
        },
        ...(staticRoot !== undefined ? { staticRoot } : {}),
    });
    server.listen(args.port, HOST, () =>
    {
        console.log(`branch-reviewer serving on http://${HOST}:${args.port} `
            + `(model ${model}, db ${DEFAULT_DB_PATH}, polling ${watches.list().length} watch(es) every ${args.pollIntervalMs / 1000}s)`);
        console.log(staticRoot !== undefined
            ? `  dashboard: http://${HOST}:${args.port}/`
            : '  dashboard: not built — API only (npm run dashboard:build to add it)');
        activityLog.push('server', `server started — model ${model}, polling every ${args.pollIntervalMs / 1000}s`);
    });

    setInterval(() =>
    {
        void poll();
    }, args.pollIntervalMs);

    // Jobs queued before a restart are still owed a run, and watches are
    // owed a pass without waiting out the first interval.
    kick();
    void poll();
}

main();
