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

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
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
// failures (a finish racing the probe) skip that campaign rather than
// aborting the sweep: this is maintenance, and the next sweep gets another
// chance. Three deliberate refusals to sweep:
//   - rows inside the grace window (see above);
//   - unleased rows — the loop admitted its lease acquisition failed, so an
//     acquirable lease proves nothing there, and failing a possibly-live,
//     billing loop would also reopen the duplicate-campaign gates; the row
//     closes when its loop does, or stays running as the honest residual of
//     degraded mode;
//   - probes that fail for any reason other than SQLITE_BUSY (truncated
//     lock file, permissions): busy is the only outcome that proves life,
//     and everything else is reported through onWarning with the path to
//     remove — never silently read as "alive", which would wedge the row
//     and its target's billing gates forever.
export function sweepInterruptedCampaigns(
    store: ReviewStore,
    opts: { graceMs?: number; onWarning?: (message: string) => void } = {},
): CampaignId[]
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
        if (!campaign.leased || Date.now() - Date.parse(campaign.createdAt) < graceMs)
        {
            continue;
        }
        let probe: Lease | undefined;
        try
        {
            probe = acquireCampaignLease(dir, campaign.id);
        }
        catch (error)
        {
            // Busy is judged by SQLite's error CODE, never by message shape:
            // a busy that failed a regex would read as "broken" and the
            // warning below would advise deleting a LIVE campaign's lock
            // file — turning the escape hatch into a kill instruction. Only
            // a definite non-busy code earns the delete advice; an error
            // with no code at all is reported without it.
            const verdict = classifyProbeError(error);
            if (verdict === 'broken')
            {
                opts.onWarning?.(`campaign #${campaign.id}'s lock file is unusable (${describeError(error)}) — remove ${leasePath(dir, campaign.id)} to let the sweep decide`);
            }
            else if (verdict === 'unknown')
            {
                opts.onWarning?.(`campaign #${campaign.id}'s lease probe failed for an unrecognized reason (${describeError(error)}) — treating it as alive`);
            }
            continue;   // busy proves life; anything else was reported, not judged
        }
        if (probe === undefined)
        {
            continue;
        }
        try
        {
            // The cause names its own uncertainty: the lease being released
            // proves the owner is gone OR that it finished without managing
            // its closing write — the recorder releases on finish even when
            // that write failed, and a fabricated "process is gone" would
            // pollute exactly the cost history campaigns exist to keep.
            store.failCampaign(campaign.id, 'Interrupted: no live lease and no closing write — the owning process died, or finished without closing its record.');
            swept.push(campaign.id);
        }
        catch (error)
        {
            // A finish racing the probe lands here — named, not swallowed.
            opts.onWarning?.(`campaign #${campaign.id} could not be marked failed (${describeError(error)}) — the next sweep retries`);
        }
        probe.release();
    }
    cleanOrphanedLocks(store, dir);
    return swept;
}

// Lock files probes and dead owners leave behind: once a row is terminal it
// is never probed again, so its file would otherwise sit in data/leases
// forever. Best-effort tidiness — a failure here costs nothing but litter.
function cleanOrphanedLocks(store: ReviewStore, dir: string): void
{
    attempt(() =>
    {
        const open = new Set(store.openCampaigns().map(c => Number(c.id)));
        for (const file of readdirSync(dir))
        {
            const match = /^campaign-(\d+)\.lock$/.exec(file);
            if (match !== null && !open.has(Number(match[1])))
            {
                attempt(() => rmSync(join(dir, file), { force: true }));
            }
        }
    });
}

// SQLITE_BUSY (5) and SQLITE_LOCKED (6) are proof of life; any other
// definite code is a broken lock file; an error carrying no code is not
// judged either way.
function classifyProbeError(error: unknown): 'busy' | 'broken' | 'unknown'
{
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode !== 'number')
    {
        return 'unknown';
    }
    return errcode === 5 || errcode === 6 ? 'busy' : 'broken';
}

function describeError(error: unknown): string
{
    return error instanceof Error ? error.message : String(error);
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
