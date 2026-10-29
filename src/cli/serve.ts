// Server entry point: wire the stores, the worker, the trigger, and the HTTP
// surface together and listen. Localhost only — exposing this is a deploy
// decision, not a default. Credit is asserted before listening: a server
// that would bill pay-as-you-go on its first job should not start at all.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubClient } from '../github/github.js';
import { reviewModel, reviewModels, verifyModel } from '../sdk/models.js';
import { assertSubscriptionCredit } from '../sdk/sdk.js';
import { EventLog } from '../server/events.js';
import { JobStore } from '../server/jobs.js';
import { createServer } from '../server/server.js';
import { pollOnce, WatchStore } from '../server/trigger.js';
import { Worker } from '../server/worker.js';
import { sweepInterruptedCampaigns } from '../store/lease.js';
import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';

const USAGE = 'Usage: npm run serve [-- --port N] [--poll-interval seconds]';
const DEFAULT_PORT = 4780;
const HOST = '127.0.0.1';
// GitHub costs one request per watch per cycle (5000/h with a token), and a
// labeled push rarely needs a sub-5-minute pickup.
const DEFAULT_POLL_INTERVAL_S = 300;
const MIN_POLL_INTERVAL_S = 10;
// How long shutdown lets open sockets settle before destroying them. Long
// enough for an in-flight response to flush; short enough that a browser's
// preconnect socket (see shutdown below) cannot hold the process hostage.
const SERVER_CLOSE_GRACE_MS = 2000;

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
    const model = reviewModel();
    const models = reviewModels();
    const campaignModels = models.length > 1 ? `campaigns rotate ${models.join(' / ')}` : `campaigns single-model ${models[0]}`;

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

    // Campaign recovery goes through liveness leases, not job linkage: a
    // running row whose lease is acquirable provably lost its owner (the
    // kernel released the fcntl lock on death — SIGKILL included), whatever
    // process owned it. A live CLI campaign's lease probes as held, so
    // sweeping here — and again every poll interval, which bounds how long
    // a Ctrl-C'd CLI campaign can read as running while this server stays
    // up — can never fail someone else's live loop.
    // Guarded whole: this runs unattended in setInterval, and a maintenance
    // task that throws (a hand-edited row failing the status validator, a
    // sick filesystem) must cost one pass, never the serve process.
    const sweepCampaigns = (): void =>
    {
        try
        {
            const swept = sweepInterruptedCampaigns(store, {
                onWarning: (message) =>
                {
                    console.error(`  sweep: ${message}`);
                    activityLog.push('server', `sweep: ${message}`);
                },
            });
            for (const id of swept)
            {
                console.error(`campaign #${id} was left running by a dead process; marked failed — its rounds survive`);
                activityLog.push('server', `campaign #${id} lost its owning process — marked failed`);
            }
        }
        catch (error)
        {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`campaign sweep failed: ${message}`);
            activityLog.push('server', `campaign sweep failed: ${message}`);
        }
    };
    sweepCampaigns();

    const worker = new Worker({
        jobs,
        store,
        clientFor: (owner, repo) => new GitHubClient(owner, repo, process.env.GITHUB_TOKEN),
        defaultModel: model,
        defaultVerifyModel: verifyModel(),
        defaultModels: models,
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
    // The in-flight pass is tracked so shutdown can wait for it: closing the
    // stores under a pass that is mid-write is a crash, not a shutdown.
    let polling = false;
    let lastPollAt: string | undefined;
    let pollInFlight: Promise<void> = Promise.resolve();
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
            // a dead poller look identical without it. No worker kick here:
            // trigger enqueues are all held, so there is never claimable work
            // until a human releases it (and the release route kicks).
            activityLog.push('trigger', `poll pass: ${watches.list().length} watch(es) — `
                + `${report.enqueued.length} enqueued, ${report.skipped} seen before, ${report.capped} deferred`);
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
        // HTTP-edge logging lives in the routes (they know held vs started);
        // this callback is purely the worker kick.
        onEnqueued: kick,
        activity: {
            log: activityLog,
            poll: () => ({ polling: true, intervalMs: args.pollIntervalMs, ...(lastPollAt !== undefined ? { lastAt: lastPollAt } : {}) }),
        },
        ...(staticRoot !== undefined ? { staticRoot } : {}),
    });
    server.listen(args.port, HOST, () =>
    {
        console.log(`branch-reviewer serving on http://${HOST}:${args.port} `
            + `(model ${model}, ${campaignModels}, db ${DEFAULT_DB_PATH}, polling ${watches.list().length} watch(es) every ${args.pollIntervalMs / 1000}s)`);
        console.log(staticRoot !== undefined
            ? `  dashboard: http://${HOST}:${args.port}/`
            : '  dashboard: not built — API only (npm run dashboard:build to add it)');
        activityLog.push('server', `server started — model ${model}, ${campaignModels}, polling every ${args.pollIntervalMs / 1000}s`);
    });

    // The overlap guard lives HERE, not only inside poll(): poll's own
    // early-return hands back a trivial resolved promise, and assigning that
    // over pollInFlight would leave shutdown waiting on nothing while the
    // real pass is still mid-write (rev 19, confirmed). kickPoll is poll's
    // only caller, so checking before the call keeps the tracked promise
    // pointing at the pass that is actually running.
    const kickPoll = (): void =>
    {
        if (!polling)
        {
            pollInFlight = poll();
        }
        sweepCampaigns();
    };
    const pollTimer = setInterval(kickPoll, args.pollIntervalMs);

    // Graceful shutdown: stop polling and claiming, let the in-flight job
    // record its outcome (the credit is already spent — killing the process
    // under it is the "credit spent, result lost" bug), then close the
    // sockets and stores. A second signal abandons the wait: the job dies
    // with the process and recovery marks it failed at the next start. Under
    // Ctrl-C the SDK's subprocess shares the terminal's SIGINT and may die
    // first; that surfaces as the job failing through the worker's normal
    // catch — an honest recorded outcome, not a silent loss.
    let shuttingDown = false;
    const shutdown = (signal: string): void =>
    {
        if (shuttingDown)
        {
            console.error('second signal — abandoning the in-flight job; it will be marked failed at the next start');
            process.exit(130);
        }
        shuttingDown = true;
        console.log(`${signal}: no new jobs will start; waiting for any in-flight job (signal again to abandon it)`);
        clearInterval(pollTimer);
        // The stores close only after everything that touches them has
        // settled: the worker's in-flight job, the trigger pass mid-write,
        // and every HTTP handler still running — a close under any of them
        // is a crash dressed as a shutdown. server.close() waits for active
        // requests and drops idle keep-alives, but a socket that never sent
        // a request — the shape of a browser preconnect — is closed by
        // neither close() nor closeIdleConnections() (probed live: an idle
        // nc connection held the close callback hostage until it died). So
        // once the worker and poller have settled, lingering sockets get a
        // grace window and are then destroyed. The store-safety guarantee is
        // the close callback itself — it fires only after active requests
        // end, and the handlers' store calls are synchronous even where the
        // handlers themselves await body reads — so a destroyed socket only
        // costs its client a response, never a write.
        const serverClosed = new Promise<void>(resolve => server.close(() => resolve()));
        server.closeIdleConnections();
        void Promise.all([worker.stop(), pollInFlight]).then(() =>
        {
            const grace = setTimeout(() => server.closeAllConnections(), SERVER_CLOSE_GRACE_MS);
            return serverClosed.finally(() => clearTimeout(grace));
        }).then(() =>
        {
            // Each close stands alone: three connections to one file, and a
            // throw from the first must not leave the other two dangling —
            // the failure gets named per store, then the exit code says so.
            const failures: string[] = [];
            for (const [name, resource] of [['jobs', jobs], ['store', store], ['watches', watches]] as const)
            {
                try
                {
                    resource.close();
                }
                catch (error)
                {
                    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            if (failures.length > 0)
            {
                console.error(`shutdown incomplete — ${failures.join('; ')}`);
                process.exit(1);
            }
            console.log('shutdown complete');
            process.exit(0);
        }).catch((error: unknown) =>
        {
            // Without this, a rejection upstream of the closes dies
            // unhandled: raw stack, no exit code of ours.
            console.error(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Jobs queued before a restart are still owed a run, and watches are
    // owed a pass without waiting out the first interval.
    kick();
    kickPoll();
}

main();
