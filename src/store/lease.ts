// Campaign liveness leases: SQLite as the flock. A campaign loop holds
// `BEGIN EXCLUSIVE` on a throwaway lock database for its whole life; SQLite
// implements that lock with POSIX fcntl locks, which the kernel releases on
// ANY process death — SIGKILL and power loss included. So "row says running
// but the lease is acquirable" is proof of an abandoned campaign, not a
// heuristic: no PID probing, no heartbeat timeouts, no stale-file guessing.
// Within one process SQLite tracks locks per inode itself (fcntl locks are
// per-process, the classic footgun), so a same-process probe still sees a
// held lease as held — the serve process can sweep while its own worker
// runs a campaign.
//
// The lease is a hint, never the authority: every sweep decision lands in
// `failCampaign`, whose running-state guard is what actually protects a row
// that finished in a race window. That is also why the unlink-on-release
// race (a probe holding an unlinked inode while a new file appears at the
// path) is harmless here — the worst a confused probe can do is attempt a
// fail that the guard refuses.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CampaignId } from '../types/ids.js';
import type { ReviewStore } from './store.js';

export interface Lease
{
    // Idempotent and non-throwing: closing the connection is what drops the
    // kernel lock, and the kernel does that on death anyway — everything
    // here is tidiness.
    release(): void;
}

function leasePath(dir: string, id: CampaignId): string
{
    return join(dir, `campaign-${id}.lock`);
}

// Undefined when the store has no lease directory (:memory: — a store that
// dies with the process has no cross-process liveness to prove). Throws
// when the lease is genuinely unavailable (already held, unwritable
// directory); the caller decides whether that is fatal.
export function acquireCampaignLease(dir: string | undefined, id: CampaignId): Lease | undefined
{
    if (dir === undefined)
    {
        return undefined;
    }
    mkdirSync(dir, { recursive: true });
    const path = leasePath(dir, id);
    const db = new DatabaseSync(path);
    try
    {
        // Immediate verdict wanted: default busy_timeout is already 0, but
        // the probe semantics depend on it, so it is stated, not assumed.
        db.exec('PRAGMA busy_timeout = 0');
        db.exec('BEGIN EXCLUSIVE');
    }
    catch (error)
    {
        db.close();
        throw error;
    }
    let released = false;
    return {
        release(): void
        {
            if (released)
            {
                return;
            }
            released = true;
            attempt(() => db.exec('ROLLBACK'));
            attempt(() => db.close());
            attempt(() => rmSync(path, { force: true }));
        },
    };
}

// A row is inserted a beat before its lease is taken — synchronous within
// the owner, but a sweep in another process can land inside that beat,
// find the lease acquirable, and fail a live, billing campaign (campaign
// #1 reported this in all six runs). The grace window closes it: rows
// younger than this are never probed, and everything older keeps the
// proof-not-heuristic property.
const CREATE_GRACE_MS = 10_000;

// Every open campaign (running or verifying — both phases bill) whose lease
// is acquirable lost its owner — mark it failed and report it. Per-campaign
// failures (unreadable lock file, a finish racing the probe) skip that
// campaign rather than aborting the sweep: this is maintenance, and the
// next sweep gets another chance. A campaign that ran without its lease
// (acquisition failed and warned) is deliberately sweepable — degraded
// liveness was the stated cost.
export function sweepInterruptedCampaigns(store: ReviewStore, opts: { graceMs?: number } = {}): CampaignId[]
{
    const dir = store.leaseDir;
    if (dir === undefined)
    {
        return [];
    }
    const graceMs = opts.graceMs ?? CREATE_GRACE_MS;
    const swept: CampaignId[] = [];
    for (const campaign of store.openCampaigns())
    {
        if (Date.now() - Date.parse(campaign.createdAt) < graceMs)
        {
            continue;
        }
        const probe = attempt(() => acquireCampaignLease(dir, campaign.id));
        if (probe === undefined)
        {
            continue;   // held — the owner is alive (or the probe itself failed; either way, not ours to fail)
        }
        const failed = attempt(() =>
        {
            store.failCampaign(campaign.id, 'Interrupted: the owning process is gone — its liveness lease was released by the kernel.');
            return true;
        });
        probe.release();
        if (failed === true)
        {
            swept.push(campaign.id);
        }
    }
    return swept;
}

// Best-effort wrapper for the lock-file plumbing: undefined is the only
// failure signal these call sites need.
function attempt<T>(action: () => T): T | undefined
{
    try
    {
        return action();
    }
    catch
    {
        return undefined;
    }
}
