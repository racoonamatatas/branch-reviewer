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
import type { Cluster, Consolidation, ReviewStore, TargetFilter, Verification } from '../store/store.js';
import type { Id } from '../types/common.js';
import { consolidationId, jobId, runId, watchId } from '../types/ids.js';
import type { JobId, WatchId } from '../types/ids.js';
import { campaignJobParamsSchema, reviewJobParamsSchema } from './jobs.js';
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
export const newJobRequestSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('review'),
        ...targetFields,
        params: reviewJobParamsSchema.prefault({}),
    }),
    z.strictObject({
        kind: z.literal('campaign'),
        ...targetFields,
        params: campaignJobParamsSchema.extend({
            maxRuns: z.number().int().positive().default(3),
            verify: z.boolean().default(true),
        }).prefault({}),
    }),
]);

// A watch request: the trigger label is policy at this edge, like the job
// defaults above.
export const newWatchRequestSchema = z.strictObject({
    owner: z.string().min(1),
    repo: z.string().min(1),
    label: z.string().min(1).default(DEFAULT_TRIGGER_LABEL),
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

    if (path === '/targets' && req.method === 'GET')
    {
        return json(res, 200, { targets: deps.store.listTargets() });
    }

    if (path === '/runs' && req.method === 'GET')
    {
        const query = parseTargetFilter(url);
        return query.ok
            ? json(res, 200, { runs: deps.store.listRuns(query.filter) })
            : json(res, 400, { error: 'Filtering needs owner, repo, and head together.' });
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

    if (path === '/consolidations' && req.method === 'GET')
    {
        const query = parseTargetFilter(url);
        return query.ok
            ? json(res, 200, { consolidations: deps.store.listConsolidations(query.filter) })
            : json(res, 400, { error: 'Filtering needs owner, repo, and head together.' });
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

    // API routes always win — the static handler only ever sees their
    // misses, so a dist file named "jobs" could never shadow the queue.
    if (deps.staticRoot !== undefined && req.method === 'GET')
    {
        return serveStatic(deps.staticRoot, path, res);
    }

    json(res, 404, { error: 'No such route.' });
}

// The target filter is all-or-nothing (see TargetFilter): a partial triple
// is a caller mistake, not a broader query.
function parseTargetFilter(url: URL): { ok: true; filter: TargetFilter | undefined } | { ok: false }
{
    const owner = url.searchParams.get('owner');
    const repo = url.searchParams.get('repo');
    const head = url.searchParams.get('head');
    if (owner === null && repo === null && head === null)
    {
        return { ok: true, filter: undefined };
    }
    if (owner === null || repo === null || head === null)
    {
        return { ok: false };
    }
    return { ok: true, filter: { owner, repo, head } };
}

// Assembled per request: cluster counts are small and the store is
// synchronous, so per-cluster verification lookups beat maintaining a
// joined query. Coverage is recomputed rather than stored — it is a pure
// function of the occurrence counts already in hand.
function detailOf(store: ReviewStore, consolidation: Consolidation): { consolidation: ConsolidationDetail; coverage: Coverage }
{
    return {
        consolidation: {
            ...consolidation,
            clusters: consolidation.clusters.map(c => ({ ...c, verifications: store.getVerifications(c.id) })),
        },
        coverage: coverageOf(consolidation.clusters),
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

    const id = deps.jobs.enqueue(parsed.data);
    deps.onEnqueued?.(id);
    json(res, 201, { job: deps.jobs.get(id) });
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
