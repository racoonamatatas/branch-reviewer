// The one place the dashboard touches the network. Every response passes
// through a schema from schemas.ts, so data past this module is as typed as
// data straight out of the store — branded ids included.

import { z } from 'zod';
import type { newJobRequestSchema, newWatchRequestSchema } from '@server/server/server';
import type { TargetFilter } from '@server/store/store';
import type { ConsolidationId, JobId, WatchId } from '@server/types/ids';
import {
    consolidationDetailSchema, consolidationSummarySchema, coverageSchema,
    jobSchema, jobSummarySchema, runSummarySchema, targetSummarySchema, watchSchema,
} from './schemas';

// The request types are the server's own schemas, imported as types: what the
// server would reject, the client cannot express.
export type NewJobRequest = z.input<typeof newJobRequestSchema>;
export type NewWatchRequest = z.input<typeof newWatchRequestSchema>;

export class ApiError extends Error
{
    constructor(public readonly status: number, message: string)
    {
        super(message);
    }
}

const errorBodySchema = z.object({ error: z.string() });

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T>
{
    const res = await fetch(path, init);
    const body: unknown = await res.json().catch(() =>
    {
        throw new ApiError(res.status, `${res.status} with a non-JSON body.`);
    });
    if (!res.ok)
    {
        const parsed = errorBodySchema.safeParse(body);
        throw new ApiError(res.status, parsed.success ? parsed.data.error : `HTTP ${res.status}`);
    }
    return schema.parse(body);
}

function post(body: unknown): RequestInit
{
    return {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
}

function targetQuery(filter?: TargetFilter): string
{
    if (filter === undefined)
    {
        return '';
    }
    const params = new URLSearchParams({ owner: filter.owner, repo: filter.repo, head: filter.head });
    return `?${params.toString()}`;
}

export const api = {
    listJobs: async () =>
        (await request('/jobs', z.object({ jobs: z.array(jobSummarySchema) }))).jobs,

    getJob: async (id: JobId) =>
        (await request(`/jobs/${id}`, z.object({ job: jobSchema }))).job,

    enqueueJob: async (job: NewJobRequest) =>
        (await request('/jobs', z.object({ job: jobSchema }), post(job))).job,

    cancelJob: async (id: JobId) =>
        (await request(`/jobs/${id}/cancel`, z.object({ job: jobSchema }), post(undefined))).job,

    listWatches: async () =>
        (await request('/watches', z.object({ watches: z.array(watchSchema) }))).watches,

    addWatch: async (watch: NewWatchRequest) =>
        (await request('/watches', z.object({ watch: watchSchema }), post(watch))).watch,

    removeWatch: async (id: WatchId) =>
        await request(`/watches/${id}`, z.object({ removed: z.number() }), { method: 'DELETE' }),

    listTargets: async () =>
        (await request('/targets', z.object({ targets: z.array(targetSummarySchema) }))).targets,

    listRuns: async (filter?: TargetFilter) =>
        (await request(`/runs${targetQuery(filter)}`, z.object({ runs: z.array(runSummarySchema) }))).runs,

    listConsolidations: async (filter?: TargetFilter) =>
        (await request(`/consolidations${targetQuery(filter)}`, z.object({ consolidations: z.array(consolidationSummarySchema) }))).consolidations,

    getConsolidation: async (id: ConsolidationId) =>
        await request(`/consolidations/${id}`, z.object({
            consolidation: consolidationDetailSchema,
            coverage: coverageSchema,
        })),
};
