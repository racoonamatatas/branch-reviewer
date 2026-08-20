// The HTTP surface: the job model (enqueue, inspect, cancel), watches, and
// the dashboard's read-only window onto run history. Nothing here touches
// the model — the worker does that — so every handler is a fast, synchronous
// store call and the server stays responsive while a review runs. Hand-rolled
// on node:http for the same reason the store is on node:sqlite: ten routes
// still do not earn a framework dependency.

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { z } from 'zod';
import { coverageOf } from '../coverage/coverage.js';
import type { Coverage } from '../coverage/coverage.js';
import type { EventLog, PollStatus } from './events.js';
import type { Cluster, Consolidation, ReviewStore, TargetFilter, Verification } from '../store/store.js';
import type { Id } from '../types/common.js';
import { campaignId, clusterId, consolidationId, jobId, runId, watchId } from '../types/ids.js';
import type { ClusterId, JobId, WatchId } from '../types/ids.js';
import { campaignJobParamsSchema, reviewJobParamsSchema, verifyJobParamsSchema } from './jobs.js';
import type { JobStore } from './jobs.js';
import { serveStatic } from './static.js';
import { DEFAULT_TRIGGER_LABEL } from './trigger.js';
import type { WatchStore } from './trigger.js';

// A job request is small; anything bigger than this is not one.
const MAX_BODY_BYTES = 64 * 1024;

const targetFields = {
    owner: z.string().min(1),
    repo: z.string().min(1),
    head: z.string().min(1),
    base: z.string().min(1).default('main'),
};

// Request-level policy lives here, not in the params schemas: the store
// records exactly what was asked, the HTTP layer decides what an omission
// means. Defaults mirror the CLI (base main, campaign of 3 runs, verify on);
// prefault parses the fallback so the inner defaults apply to it too.
// `start` defaults false: enqueueing proposes, and only an explicit start
// (or a later release) lets the worker claim it — same posture as the
// trigger's held enqueues.
export const newJobRequestSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('review'),
        ...targetFields,
        start: z.boolean().default(false),
        params: reviewJobParamsSchema.prefault({}),
    }),
    z.strictObject({
        kind: z.literal('campaign'),
        ...targetFields,
        start: z.boolean().default(false),
        params: campaignJobParamsSchema.extend({
            maxRuns: z.number().int().positive().default(3),
            verify: z.boolean().default(true),
        }).prefault({}),
    }),
    z.strictObject({
        kind: z.literal('verify'),
        ...targetFields,
        start: z.boolean().default(false),
        params: verifyJobParamsSchema.prefault({}),
    }),
]);

// A watch request: the trigger label is policy at this edge, like the job
// defaults above.
export const newWatchRequestSchema = z.strictObject({
    owner: z.string().min(1),
    repo: z.string().min(1),
    label: z.string().min(1).default(DEFAULT_TRIGGER_LABEL),
});

// A human verdict. confirmed/refuted only — undetermined is the machine's
// honest "I don't know", and a human who doesn't know doesn't stamp. The
// rationale is required: verdicts inherit across consolidations by member
// set, so a bare stamp would propagate with no trace of why it was earned.
export const humanVerdictRequestSchema = z.strictObject({
    verdict: z.enum(['confirmed', 'refuted']),
    rationale: z.string().min(1),
});

// What the dashboard reads per cluster: the entity plus its verification
// history (append-only — the last row is the verdict the cluster shows).
export interface ClusterDetail extends Cluster
{
    verifications: Verification[];
}

export interface ConsolidationDetail extends Consolidation
{
    clusters: ClusterDetail[];
}

export interface ServerDeps
{
    jobs: JobStore;
    watches: WatchStore;
    // The dashboard's read-only window: runs, consolidations, verdicts.
    // Never written from HTTP — the worker owns every write to it.
    store: ReviewStore;
    // The worker kick — called after every successful enqueue. The server
    // does not know the worker; the wiring entry point ties them together.
    onEnqueued?: (id: JobId) => void;
    // The liveness feed and the poller's heartbeat, owned by the wiring entry
    // point. Required: a server that can't say whether it's alive shouldn't
    // exist — a pollerless wiring (fixture, tests) says { polling: false }.
    activity: {
        log: EventLog;
        poll: () => PollStatus;
    };
    // Absolute path to the built dashboard (dashboard/dist). When set, GETs
    // that miss every API route are served from it; when not, the server is
    // API-only and those misses stay JSON 404s.
    staticRoot?: string;
}

export function createServer(deps: ServerDeps): Server
{
    return createHttpServer((req, res) =>
    {
        route(deps, req, res).catch((error: unknown) =>
        {
            const message = error instanceof Error ? error.message : String(error);
            json(res, 500, { error: message });
        });
    });
}

async function route(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void>
{
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/jobs' && req.method === 'POST')
    {
        return postJob(deps, req, res);
    }
    if (path === '/jobs' && req.method === 'GET')
    {
        return json(res, 200, { jobs: deps.jobs.list() });
    }

    const show = /^\/jobs\/(\d+)$/.exec(path);
    if (show !== null && req.method === 'GET')
    {
        const id = parseId(show[1], jobId);
        const job = id === undefined ? undefined : deps.jobs.get(id);
        return job === undefined
            ? json(res, 404, { error: 'No such job.' })
            : json(res, 200, { job });
    }

    const cancel = /^\/jobs\/(\d+)\/cancel$/.exec(path);
    if (cancel !== null && req.method === 'POST')
    {
        const id = parseId(cancel[1], jobId);
        return id === undefined
            ? json(res, 404, { error: 'No such job.' })
            : cancelJob(deps, id, res);
    }

    // The human "go" for a held job — the one transition that starts billing.
    const release = /^\/jobs\/(\d+)\/release$/.exec(path);
    if (release !== null && req.method === 'POST')
    {
        const id = parseId(release[1], jobId);
        return id === undefined
            ? json(res, 404, { error: 'No such job.' })
            : releaseJob(deps, id, res);
    }

    if (path === '/watches' && req.method === 'POST')
    {
        return postWatch(deps, req, res);
    }
    if (path === '/watches' && req.method === 'GET')
    {
        return json(res, 200, { watches: deps.watches.list() });
    }

    const unwatch = /^\/watches\/(\d+)$/.exec(path);
    if (unwatch !== null && req.method === 'DELETE')
    {
        const id = parseId(unwatch[1], watchId);
        return id === undefined
            ? json(res, 404, { error: 'No such watch.' })
            : deleteWatch(deps, id, res);
    }

    // The liveness tail: ?after=seq returns only what the client hasn't seen,
    // so the 3-second dashboard poll usually carries an empty array.
    if (path === '/events' && req.method === 'GET')
    {
        const raw = url.searchParams.get('after');
        const after = raw === null ? 0 : Number(raw);
        if (!Number.isInteger(after) || after < 0)
        {
            return json(res, 400, { error: 'after must be a non-negative integer.' });
        }
        return json(res, 200, {
            events: deps.activity.log.since(after),
            boot: deps.activity.log.boot,
            poll: deps.activity.poll(),
        });
    }

    if (path === '/targets' && req.method === 'GET')
    {
        return json(res, 200, { targets: deps.store.listTargets() });
    }

    if (path === '/runs' && req.method === 'GET')
    {
        const query = parseTargetFilter(url);
        return query.ok
            ? json(res, 200, { runs: deps.store.listRuns(query.filter) })
            : json(res, 400, { error: FILTER_400 });
    }

    // A run's own findings, ids and provenance included — the dashboard's
    // window onto a run no consolidation has absorbed yet. Unverified by
    // definition: verification hangs off clusters, so these rows carry no
    // verdict and the UI must present them as claims, not facts.
    const runDetail = /^\/runs\/(\d+)\/findings$/.exec(path);
    if (runDetail !== null && req.method === 'GET')
    {
        const id = parseId(runDetail[1], runId);
        return id === undefined || deps.store.getRun(id) === undefined
            ? json(res, 404, { error: 'No such run.' })
            : json(res, 200, { findings: deps.store.getFindings(id) });
    }

    // ?live=1 bounds the aggregate to running/verifying rows — the
    // dashboard's per-poll question, asked every 3 seconds, must not join
    // every campaign ever stored to be answered.
    if (path === '/campaigns' && req.method === 'GET')
    {
        const query = parseTargetFilter(url);
        const live = url.searchParams.get('live') === '1';
        return query.ok
            ? json(res, 200, { campaigns: deps.store.listCampaigns(query.filter, { liveOnly: live }) })
            : json(res, 400, { error: FILTER_400 });
    }

    // The whole record, rounds included — as-it-happened snapshots, so the
    // dashboard's loop band can answer "what did the campaign see when it
    // decided to stop" instead of re-deriving from a partition that may have
    // moved on.
    const campaignDetail = /^\/campaigns\/(\d+)$/.exec(path);
    if (campaignDetail !== null && req.method === 'GET')
    {
        const id = parseId(campaignDetail[1], campaignId);
        const campaign = id === undefined ? undefined : deps.store.getCampaign(id);
        return campaign === undefined
            ? json(res, 404, { error: 'No such campaign.' })
            : json(res, 200, { campaign });
    }

    if (path === '/consolidations' && req.method === 'GET')
    {
        const query = parseTargetFilter(url);
        return query.ok
            ? json(res, 200, { consolidations: deps.store.listConsolidations(query.filter) })
            : json(res, 400, { error: FILTER_400 });
    }

    const detail = /^\/consolidations\/(\d+)$/.exec(path);
    if (detail !== null && req.method === 'GET')
    {
        const id = parseId(detail[1], consolidationId);
        const consolidation = id === undefined ? undefined : deps.store.getConsolidation(id);
        return consolidation === undefined
            ? json(res, 404, { error: 'No such consolidation.' })
            : json(res, 200, detailOf(deps.store, consolidation));
    }

    // The review store's one HTTP write, and a deliberate breach of "the
    // worker owns every write": a human verdict is the single write that
    // cannot come from the worker. It appends to the verification history —
    // overrule, never overwrite.
    const stamp = /^\/clusters\/(\d+)\/verdict$/.exec(path);
    if (stamp !== null && req.method === 'POST')
    {
        const id = parseId(stamp[1], clusterId);
        return id === undefined
            ? json(res, 404, { error: 'No such cluster.' })
            : postVerdict(deps, id, req, res);
    }

    // API routes always win — the static handler only ever sees their
    // misses, so a dist file named "jobs" could never shadow the queue.
    if (deps.staticRoot !== undefined && req.method === 'GET')
    {
        return serveStatic(deps.staticRoot, path, res);
    }

    json(res, 404, { error: 'No such route.' });
}

// One string, used by every filtered route: the 400 must describe every
// rejection parseTargetFilter produces, base rules included.
const FILTER_400 = 'Filtering needs owner, repo, and head together, all non-empty; base is optional but must be non-empty and ride on the full triple.';

// The target filter is all-or-nothing (see TargetFilter): a partial triple
// is a caller mistake, not a broader query, and a present-but-empty value
// is rejected the same way — an empty string pins to a target that cannot
// exist. base rides optionally on top of a complete triple: it pins the
// comparison, it never widens the query, so a lone base is rejected too.
function parseTargetFilter(url: URL): { ok: true; filter: TargetFilter | undefined } | { ok: false }
{
    const owner = url.searchParams.get('owner');
    const repo = url.searchParams.get('repo');
    const head = url.searchParams.get('head');
    const base = url.searchParams.get('base');
    if (owner === null && repo === null && head === null)
    {
        return base === null ? { ok: true, filter: undefined } : { ok: false };
    }
    if (owner === null || owner === '' || repo === null || repo === '' || head === null || head === '' || base === '')
    {
        return { ok: false };
    }
    return { ok: true, filter: { owner, repo, head, ...(base !== null ? { base } : {}) } };
}

// Assembled per request: cluster counts are small and the store is
// synchronous, so per-cluster verification lookups beat maintaining a
// joined query. Coverage is recomputed rather than stored — it is a pure
// function of the occurrence counts already in hand. Refuted clusters are
// excluded from the estimator's input: a disproven claim is not a
// discovered finding, and counting it inflates both observed and the
// estimate of what remains unseen.
function detailOf(store: ReviewStore, consolidation: Consolidation): { consolidation: ConsolidationDetail; coverage: Coverage }
{
    return {
        consolidation: {
            ...consolidation,
            clusters: consolidation.clusters.map(c => ({ ...c, verifications: store.getVerifications(c.id) })),
        },
        coverage: coverageOf(consolidation.clusters.filter(c => c.verificationStatus !== 'refuted')),
    };
}

// The route regexes admit "0", which the id constructors rightly refuse; an
// id that cannot exist is a 404, not a crash. The constructor parameter is
// constrained to branded-id constructors (same shape toTypedId requires), so
// a plain (n: number) => number like Number cannot launder an unbranded id
// through here.
function parseId<T extends string>(text: string | undefined, constructor: (n: number) => Id<T>): Id<T> | undefined
{
    const n = Number(text);
    return Number.isInteger(n) && n > 0 ? constructor(n) : undefined;
}

async function postJob(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void>
{
    const raw = await readJson(req, res);
    if (!raw.ok)
    {
        return;
    }

    const parsed = newJobRequestSchema.safeParse(raw.value);
    if (!parsed.success)
    {
        return json(res, 400, { error: z.prettifyError(parsed.error) });
    }

    // `start` is request policy, not job data — it decides the door the job
    // enters through and is not stored. The worker is only kicked for a job
    // it is actually allowed to claim.
    const { start, ...job } = parsed.data;
    const id = deps.jobs.enqueue(job, { held: !start });
    deps.activity.log.push('server', `job #${id} enqueued over HTTP (${job.kind}${start ? '' : ' — held, release to run'})`);
    if (start)
    {
        deps.onEnqueued?.(id);
    }
    json(res, 201, { job: deps.jobs.get(id) });
}

async function postVerdict(deps: ServerDeps, id: ClusterId, req: IncomingMessage, res: ServerResponse): Promise<void>
{
    const raw = await readJson(req, res);
    if (!raw.ok)
    {
        return;
    }

    const parsed = humanVerdictRequestSchema.safeParse(raw.value);
    if (!parsed.success)
    {
        return json(res, 400, { error: z.prettifyError(parsed.error) });
    }

    // The store's own existence check speaks: an unknown cluster throws a
    // named error before anything is written.
    try
    {
        deps.store.saveVerification({ source: 'human', clusterId: id, ...parsed.data });
    }
    catch
    {
        return json(res, 404, { error: 'No such cluster.' });
    }
    json(res, 201, { verifications: deps.store.getVerifications(id) });
}

async function postWatch(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void>
{
    const raw = await readJson(req, res);
    if (!raw.ok)
    {
        return;
    }

    const parsed = newWatchRequestSchema.safeParse(raw.value);
    if (!parsed.success)
    {
        return json(res, 400, { error: z.prettifyError(parsed.error) });
    }

    // The UNIQUE constraint speaks here: a duplicate watch is a conflict
    // with existing state, not a malformed request.
    try
    {
        const id = deps.watches.add(parsed.data);
        json(res, 201, { watch: deps.watches.list().find(w => w.id === id) });
    }
    catch (error)
    {
        json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
}

function deleteWatch(deps: ServerDeps, id: WatchId, res: ServerResponse): void
{
    try
    {
        deps.watches.remove(id);
    }
    catch
    {
        return json(res, 404, { error: 'No such watch.' });
    }
    json(res, 200, { removed: id });
}

// 404 and 409 are different answers, so the missing-job check comes first;
// the store's own guard then makes a losing race (claimed between check and
// cancel) a named 409 instead of a double-write.
function cancelJob(deps: ServerDeps, id: JobId, res: ServerResponse): void
{
    if (deps.jobs.get(id) === undefined)
    {
        return json(res, 404, { error: 'No such job.' });
    }
    try
    {
        deps.jobs.cancel(id);
    }
    catch (error)
    {
        return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
    deps.activity.log.push('server', `job #${id} cancelled`);
    json(res, 200, { job: deps.jobs.get(id) });
}

// Same 404/409 split as cancel; the worker kick happens only after the
// transition commits, so a lost race never wakes the worker for nothing.
function releaseJob(deps: ServerDeps, id: JobId, res: ServerResponse): void
{
    if (deps.jobs.get(id) === undefined)
    {
        return json(res, 404, { error: 'No such job.' });
    }
    try
    {
        deps.jobs.release(id);
    }
    catch (error)
    {
        return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
    deps.activity.log.push('server', `job #${id} released — worker may claim it`);
    deps.onEnqueued?.(id);
    json(res, 200, { job: deps.jobs.get(id) });
}

// Reads and parses a JSON body; on failure the response has already been
// sent and the caller just returns.
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; value: unknown } | { ok: false }>
{
    const body = await readBody(req);
    if (!body.ok)
    {
        json(res, 413, { error: `Request body exceeds ${MAX_BODY_BYTES} bytes.` });
        return { ok: false };
    }
    try
    {
        return { ok: true, value: JSON.parse(body.text) };
    }
    catch
    {
        json(res, 400, { error: 'Request body is not valid JSON.' });
        return { ok: false };
    }
}

type Body = { ok: true; text: string } | { ok: false };

async function readBody(req: IncomingMessage): Promise<Body>
{
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req)
    {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
        {
            return { ok: false };
        }
        chunks.push(buffer);
    }
    return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

function json(res: ServerResponse, status: number, body: unknown): void
{
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}
