// The server's job model: a durable queue of review/campaign requests in the
// same SQLite database as the results they produce. States move strictly
// queued → running → succeeded | aborted | failed (queued → cancelled is the
// one exit before work starts); every transition is guarded by its expected
// prior state, so a stale caller gets a named error instead of a silent
// double-write. A job found `running` at startup was interrupted mid-flight —
// it is marked failed, never silently re-run: a re-run bills real credit,
// which is a human decision.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Created, Identified, New } from '../types/common.js';
import { consolidationId, jobId, runId } from '../types/ids.js';
import type { ConsolidationId, JobId, RunId } from '../types/ids.js';

// Params mirror the option surface of the stage they run (ReviewRunOptions /
// CampaignOptions minus callbacks); policy like "verify defaults on" stays in
// the campaign module, not here. Zod is the runtime source of truth: params
// cross two untrusted boundaries — the HTTP body in, and the JSON column back
// out of the database.

export const reviewJobParamsSchema = z.strictObject({
    model: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
});

export const campaignJobParamsSchema = z.strictObject({
    model: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
    maxRuns: z.number().int().positive(),
    patience: z.number().int().positive().optional(),
    verify: z.boolean(),
    reverify: z.boolean().optional(),
});

export type ReviewJobParams = z.infer<typeof reviewJobParamsSchema>;
export type CampaignJobParams = z.infer<typeof campaignJobParamsSchema>;

export type JobState = 'queued' | 'running' | 'succeeded' | 'aborted' | 'failed' | 'cancelled';

// Discriminated on kind so params never need downcasting at the use site.
interface JobCommon extends Identified<'Job'>, Created
{
    owner: string;
    repo: string;
    head: string;
    base: string;
    state: JobState;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    // Results as they land: one run for a review job, one per round for a
    // campaign — visible mid-flight, which is the point of a job model.
    runIds: RunId[];
    consolidationId?: ConsolidationId;
}

export interface ReviewJob extends JobCommon
{
    kind: 'review';
    params: ReviewJobParams;
}

export interface CampaignJob extends JobCommon
{
    kind: 'campaign';
    params: CampaignJobParams;
}

export type Job = ReviewJob | CampaignJob;

// Everything beyond New<T>'s subtraction is lifecycle, assigned by the store
// as the job progresses; a create call supplies only the request itself.
type Lifecycle = 'state' | 'startedAt' | 'finishedAt' | 'error' | 'runIds' | 'consolidationId';
export type NewReviewJob = Omit<New<ReviewJob>, Lifecycle>;
export type NewCampaignJob = Omit<New<CampaignJob>, Lifecycle>;
export type NewJob = NewReviewJob | NewCampaignJob;

export interface JobSummary extends Pick<Job, 'id' | 'createdAt' | 'kind' | 'state'>
{
    target: string;  // "owner/repo head → base"
    runCount: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    head TEXT NOT NULL,
    base TEXT NOT NULL,
    params TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    run_ids TEXT NOT NULL DEFAULT '[]',
    consolidation_id INTEGER
);
`;

interface JobRow
{
    id: number;
    created_at: string;
    kind: string;
    owner: string;
    repo: string;
    head: string;
    base: string;
    params: string;
    state: string;
    started_at: string | null;
    finished_at: string | null;
    error: string | null;
    run_ids: string;
    consolidation_id: number | null;
}

export class JobStore
{
    private readonly db: DatabaseSync;

    constructor(path: string)
    {
        if (path !== ':memory:')
        {
            mkdirSync(dirname(path), { recursive: true });
        }
        this.db = new DatabaseSync(path);
        this.db.exec(SCHEMA);
    }

    enqueue(job: NewJob): JobId
    {
        const result = this.db.prepare(
            'INSERT INTO jobs (created_at, kind, owner, repo, head, base, params) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
            new Date().toISOString(), job.kind, job.owner, job.repo, job.head, job.base,
            JSON.stringify(job.params),
        );
        return jobId(Number(result.lastInsertRowid));
    }

    get(id: JobId): Job | undefined
    {
        const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
        return row === undefined ? undefined : toJob(row);
    }

    list(): JobSummary[]
    {
        const rows = this.db.prepare('SELECT * FROM jobs ORDER BY id DESC').all() as unknown as JobRow[];
        return rows.map(row => ({
            id: jobId(row.id),
            createdAt: row.created_at,
            kind: row.kind as Job['kind'],
            state: row.state as JobState,
            target: `${row.owner}/${row.repo} ${row.head} → ${row.base}`,
            runCount: (JSON.parse(row.run_ids) as number[]).length,
        }));
    }

    // The single worker's intake: oldest queued job moves to running. The
    // WHERE state = 'queued' guard makes the claim atomic even if a second
    // consumer ever appears; losing the race just means claiming the next one.
    claimNext(): Job | undefined
    {
        const row = this.db.prepare(
            "SELECT * FROM jobs WHERE state = 'queued' ORDER BY id LIMIT 1",
        ).get() as unknown as JobRow | undefined;
        if (row === undefined)
        {
            return undefined;
        }
        const claimed = this.db.prepare(
            "UPDATE jobs SET state = 'running', started_at = ? WHERE id = ? AND state = 'queued'",
        ).run(new Date().toISOString(), row.id);
        if (claimed.changes === 0)
        {
            return this.claimNext();
        }
        return this.get(jobId(row.id));
    }

    // Append a result as it lands, while the job is still running — a
    // campaign's runs are visible round by round, not only at the end.
    recordRun(id: JobId, run: RunId): void
    {
        const row = this.requireState(id, 'running', 'record a run on');
        const runIds = [...(JSON.parse(row.run_ids) as number[]), run];
        this.db.prepare('UPDATE jobs SET run_ids = ? WHERE id = ?').run(JSON.stringify(runIds), id);
    }

    succeed(id: JobId, result: { consolidationId?: ConsolidationId } = {}): void
    {
        this.finish(id, 'succeeded', { consolidationId: result.consolidationId });
    }

    // The capped outcome from the locked taxonomy: the model ran out of turn
    // budget. Not a success (no review landed) and not our failure (the
    // request was fine) — its own terminal state, mirroring run status.
    abort(id: JobId, reason: string): void
    {
        this.finish(id, 'aborted', { error: reason });
    }

    fail(id: JobId, error: string): void
    {
        this.finish(id, 'failed', { error });
    }

    // Only a job that has not started can be cancelled; anything running has
    // already spent credit and finishes on its own terms.
    cancel(id: JobId): void
    {
        this.requireState(id, 'queued', 'cancel');
        this.db.prepare(
            "UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE id = ? AND state = 'queued'",
        ).run(new Date().toISOString(), id);
    }

    // Startup recovery: a job still `running` belongs to a process that no
    // longer exists. Mark it failed and report it — never silently re-run.
    recoverInterrupted(): JobId[]
    {
        const rows = this.db.prepare(
            "SELECT id FROM jobs WHERE state = 'running' ORDER BY id",
        ).all() as unknown as Array<{ id: number }>;
        for (const row of rows)
        {
            this.fail(jobId(row.id), 'Interrupted: the server stopped while this job was running.');
        }
        return rows.map(row => jobId(row.id));
    }

    private finish(id: JobId, state: 'succeeded' | 'aborted' | 'failed', extra: { error?: string; consolidationId?: ConsolidationId }): void
    {
        this.requireState(id, 'running', state === 'succeeded' ? 'complete' : state === 'aborted' ? 'abort' : 'fail');
        this.db.prepare(
            "UPDATE jobs SET state = ?, finished_at = ?, error = ?, consolidation_id = ? WHERE id = ? AND state = 'running'",
        ).run(state, new Date().toISOString(), extra.error ?? null, extra.consolidationId ?? null, id);
    }

    private requireState(id: JobId, expected: JobState, action: string): JobRow
    {
        const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
        if (row === undefined)
        {
            throw new Error(`No job #${id}.`);
        }
        if (row.state !== expected)
        {
            throw new Error(`Cannot ${action} job #${id}: it is ${row.state}, not ${expected}.`);
        }
        return row;
    }

    close(): void
    {
        this.db.close();
    }
}

function toJob(row: JobRow): Job
{
    const common = {
        id: jobId(row.id),
        createdAt: row.created_at,
        owner: row.owner,
        repo: row.repo,
        head: row.head,
        base: row.base,
        state: row.state as JobState,
        ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
        ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
        ...(row.error !== null ? { error: row.error } : {}),
        runIds: (JSON.parse(row.run_ids) as number[]).map(runId),
        ...(row.consolidation_id !== null ? { consolidationId: consolidationId(row.consolidation_id) } : {}),
    };
    // Params re-enter through Zod: the JSON column is as untrusted as the
    // HTTP body it originally arrived in.
    switch (row.kind)
    {
        case 'review':
            return { ...common, kind: 'review', params: reviewJobParamsSchema.parse(JSON.parse(row.params)) };
        case 'campaign':
            return { ...common, kind: 'campaign', params: campaignJobParamsSchema.parse(JSON.parse(row.params)) };
        default:
            throw new Error(`Job #${row.id} has unknown kind '${row.kind}'.`);
    }
}
