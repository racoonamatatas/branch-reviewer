// The HTTP surface of the job model: enqueue, inspect, cancel. Nothing here
// touches the model — the worker does that — so every handler is a fast,
// synchronous store call and the server stays responsive while a review
// runs. Hand-rolled on node:http for the same reason the store is on
// node:sqlite: four routes do not earn a framework dependency.

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { z } from 'zod';
import { jobId } from '../types/ids.js';
import type { JobId } from '../types/ids.js';
import { campaignJobParamsSchema, reviewJobParamsSchema } from './jobs.js';
import type { JobStore } from './jobs.js';

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

export interface ServerDeps
{
    jobs: JobStore;
    // The worker kick — called after every successful enqueue. The server
    // does not know the worker; the wiring entry point ties them together.
    onEnqueued?: (id: JobId) => void;
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
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

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
        const id = parseId(show[1]);
        const job = id === undefined ? undefined : deps.jobs.get(id);
        return job === undefined
            ? json(res, 404, { error: 'No such job.' })
            : json(res, 200, { job });
    }

    const cancel = /^\/jobs\/(\d+)\/cancel$/.exec(path);
    if (cancel !== null && req.method === 'POST')
    {
        const id = parseId(cancel[1]);
        return id === undefined
            ? json(res, 404, { error: 'No such job.' })
            : cancelJob(deps, id, res);
    }

    json(res, 404, { error: 'No such route.' });
}

// The route regex admits "0", which the id constructor rightly refuses; an
// id that cannot exist is a 404, not a crash.
function parseId(text: string | undefined): JobId | undefined
{
    const n = Number(text);
    return Number.isInteger(n) && n > 0 ? jobId(n) : undefined;
}

async function postJob(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void>
{
    const body = await readBody(req);
    if (!body.ok)
    {
        return json(res, 413, { error: `Request body exceeds ${MAX_BODY_BYTES} bytes.` });
    }

    let raw: unknown;
    try
    {
        raw = JSON.parse(body.text);
    }
    catch
    {
        return json(res, 400, { error: 'Request body is not valid JSON.' });
    }

    const parsed = newJobRequestSchema.safeParse(raw);
    if (!parsed.success)
    {
        return json(res, 400, { error: z.prettifyError(parsed.error) });
    }

    const id = deps.jobs.enqueue(parsed.data);
    deps.onEnqueued?.(id);
    json(res, 201, { job: deps.jobs.get(id) });
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
