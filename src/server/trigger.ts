// The trigger: which repos to watch, and one poll pass over them. A watch is
// label-gated — only PRs carrying the trigger label are reviewed, so spending
// credit stays an opt-in act on the PR itself, and removing the label stops
// future reviews. The dedupe key is the head SHA: a new push is a new SHA and
// triggers naturally, while a SHA with any existing job — including failed or
// cancelled — is never re-enqueued by automation. A failed job is a human
// decision to retry; a cancelled one was a human saying no.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PullRequest, PullSource } from '../github/github.js';
import type { Created, Identified, New } from '../types/common.js';
import { watchId } from '../types/ids.js';
import type { JobId, WatchId } from '../types/ids.js';
import type { JobStore } from './jobs.js';

export const DEFAULT_TRIGGER_LABEL = 'agent-review';

// The cost fuse: one poll cycle enqueues at most this many jobs, whatever the
// backlog looks like. A freshly-watched busy repo trickles in over cycles
// instead of billing its whole label backlog at once.
const DEFAULT_MAX_ENQUEUES_PER_CYCLE = 5;

export interface Watch extends Identified<'Watch'>, Created
{
    owner: string;
    repo: string;
    label: string;
}

export type NewWatch = New<Watch>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    label TEXT NOT NULL,
    UNIQUE (owner, repo, label)
);
`;

interface WatchRow
{
    id: number;
    created_at: string;
    owner: string;
    repo: string;
    label: string;
}

export class WatchStore
{
    private readonly db: DatabaseSync;

    constructor(path: string)
    {
        if (path !== ':memory:')
        {
            mkdirSync(dirname(path), { recursive: true });
        }
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA busy_timeout = 5000');
        this.db.exec(SCHEMA);
    }

    add(watch: NewWatch): WatchId
    {
        try
        {
            const result = this.db.prepare(
                'INSERT INTO watches (created_at, owner, repo, label) VALUES (?, ?, ?, ?)',
            ).run(new Date().toISOString(), watch.owner, watch.repo, watch.label);
            return watchId(Number(result.lastInsertRowid));
        }
        catch (error)
        {
            // errcode 2067 is SQLITE_CONSTRAINT_UNIQUE; the message check is
            // the fallback for node:sqlite versions that don't attach it.
            const unique = error instanceof Error
                && ((error as { errcode?: number }).errcode === 2067 || error.message.includes('UNIQUE'));
            if (unique)
            {
                throw new Error(`Already watching ${watch.owner}/${watch.repo} for label "${watch.label}".`, { cause: error });
            }
            throw error;
        }
    }

    list(): Watch[]
    {
        const rows = this.db.prepare('SELECT * FROM watches ORDER BY id').all() as unknown as WatchRow[];
        return rows.map(row => ({
            id: watchId(row.id),
            createdAt: row.created_at,
            owner: row.owner,
            repo: row.repo,
            label: row.label,
        }));
    }

    remove(id: WatchId): void
    {
        const result = this.db.prepare('DELETE FROM watches WHERE id = ?').run(id);
        if (result.changes === 0)
        {
            throw new Error(`No watch #${id}.`);
        }
    }

    close(): void
    {
        this.db.close();
    }
}

export interface TriggerDeps
{
    watches: WatchStore;
    jobs: JobStore;
    pullSourceFor: (owner: string, repo: string) => PullSource;
    maxEnqueuesPerCycle?: number;
    onEvent?: (event: string) => void;
}

export interface PollReport
{
    enqueued: JobId[];
    skipped: number;   // labeled PRs whose head SHA already has a job
    capped: number;    // labeled PRs deferred to a later cycle by the cost fuse
    errors: string[];  // per-watch failures; one unreachable repo must not stop the rest
}

// One poll pass: for every watch, every open non-draft PR carrying the
// trigger label whose head SHA has no job yet gets a review job enqueued.
// The head is the SHA, not the branch name — the job reviews exactly the
// state that carried the label, even if the branch moves before the worker
// gets there. Pure wiring over its deps: the caller owns the interval and
// the worker kick.
export async function pollOnce(deps: TriggerDeps): Promise<PollReport>
{
    const cap = deps.maxEnqueuesPerCycle ?? DEFAULT_MAX_ENQUEUES_PER_CYCLE;
    const report: PollReport = { enqueued: [], skipped: 0, capped: 0, errors: [] };

    for (const watch of deps.watches.list())
    {
        let pulls: PullRequest[];
        try
        {
            pulls = await deps.pullSourceFor(watch.owner, watch.repo).listOpenPulls();
        }
        catch (error)
        {
            report.errors.push(`${watch.owner}/${watch.repo}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        for (const pull of pulls)
        {
            if (pull.draft || !pull.labels.includes(watch.label))
            {
                continue;
            }
            if (deps.jobs.hasJobFor(watch.owner, watch.repo, pull.headSha))
            {
                report.skipped++;
                continue;
            }
            if (report.enqueued.length >= cap)
            {
                report.capped++;
                continue;
            }
            // Held, not queued: the label proposes the review, a human release
            // disposes — automation alone never moves credit. The PR title
            // rides along as intent for the reviewer's prompt.
            const id = deps.jobs.enqueue({
                kind: 'review',
                owner: watch.owner,
                repo: watch.repo,
                head: pull.headSha,
                base: pull.baseRef,
                params: { context: `PR #${pull.number}: ${pull.title}` },
            }, { held: true });
            report.enqueued.push(id);
            deps.onEvent?.(`${watch.owner}/${watch.repo} PR #${pull.number} (${pull.headSha.slice(0, 7)}) enqueued as job #${id} — held, release to run`);
        }
    }

    return report;
}
