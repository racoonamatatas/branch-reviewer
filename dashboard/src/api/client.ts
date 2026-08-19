// The one place the dashboard touches the network. Every response passes
// through a schema from schemas.ts, so data past this module is as typed as
// data straight out of the store — branded ids included.

import { z } from 'zod';
import type { humanVerdictRequestSchema, newJobRequestSchema, newWatchRequestSchema } from '@server/server/server';
import type { TargetFilter } from '@server/store/store';
import type { ClusterId, ConsolidationId, JobId, RunId, WatchId } from '@server/types/ids';
import {
    activityEventSchema, consolidationDetailSchema, consolidationSummarySchema, coverageSchema, findingSchema,
    jobSchema, jobSummarySchema, pollStatusSchema, runSummarySchema, targetSummarySchema, verificationSchema, watchSchema,
} from './schemas';

// The request types are the server's own schemas, imported as types: what the
// server would reject, the client cannot express.
export type NewJobRequest = z.input<typeof newJobRequestSchema>;
export type NewWatchRequest = z.input<typeof newWatchRequestSchema>;
export type HumanVerdictRequest = z.input<typeof humanVerdictRequestSchema>;

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
    // Every request must settle: usePolling's in-flight guard clears in a
    // finally(), so one fetch that never resolves (stalled connection,
    // server wedged mid-response) would latch the guard and kill the poll
    // loop for the life of the tab. 10s is more than three poll intervals.
    // Signal last, so a future init cannot silently spread the timeout away.
    const res = await fetch(path, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) });
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
    // base is the filter's one optional field — dropping it here would make
    // the type lie (a caller that pins base would get unfiltered results).
    if (filter.base !== undefined)
    {
        params.set('base', filter.base);
    }
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

    // The human "go" for a held job — this is the click that starts billing.
    releaseJob: async (id: JobId) =>
        (await request(`/jobs/${id}/release`, z.object({ job: jobSchema }), post(undefined))).job,

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

    getRunFindings: async (id: RunId) =>
        (await request(`/runs/${id}/findings`, z.object({ findings: z.array(findingSchema) }))).findings,

    listConsolidations: async (filter?: TargetFilter) =>
        (await request(`/consolidations${targetQuery(filter)}`, z.object({ consolidations: z.array(consolidationSummarySchema) }))).consolidations,

    stampVerdict: async (id: ClusterId, verdict: HumanVerdictRequest) =>
        (await request(`/clusters/${id}/verdict`, z.object({ verifications: z.array(verificationSchema) }), post(verdict))).verifications,

    // The tail past a cursor; 0 (or omitted) fetches the whole ring. `boot`
    // names the server's process life — when it changes, the caller's cursor
    // describes a ring that no longer exists and the tail must be refetched
    // whole, never appended across lives.
    listEvents: async (after = 0) =>
        await request(`/events${after > 0 ? `?after=${after}` : ''}`, z.object({
            events: z.array(activityEventSchema),
            boot: z.string(),
            poll: pollStatusSchema,
        })),

    getConsolidation: async (id: ConsolidationId) =>
        await request(`/consolidations/${id}`, z.object({
            consolidation: consolidationDetailSchema,
            coverage: coverageSchema,
        })),
};
